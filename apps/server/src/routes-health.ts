import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appendEvent, getIncident, listIncidents, sql, updateIncident, type DB, type IncidentStatus } from '@quarry/db';
import { llmPausedUntil, pausedPlugins, setLlmPausedUntil, setPluginPause, setTenantOverride, tenantOverrides } from '@quarry/core';
import type { TickResult } from '@quarry/orchestrator';

// Phase 22: the Health tab — incidents, the orchestrator's switches, LLM spend.
// Resuming / clearing here is you overriding the orchestrator; nothing sends.

export interface HealthRouteOptions {
  db: DB;
  /** Run one orchestrator pass now. */
  runOrchestrator?: () => Promise<TickResult>;
  budgetUsd?: number | null;
}

const STATUSES = ['open', 'acting', 'verifying', 'resolved', 'escalated'] as const;

export function registerHealthRoutes(app: FastifyInstance, o: HealthRouteOptions): void {
  app.get('/api/incidents', async (req) => {
    const q = z
      .object({
        status: z
          .string()
          .optional()
          .transform((s) => (s ? s.split(',').filter(Boolean) : undefined))
          .pipe(z.array(z.enum(STATUSES)).optional()),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .strict()
      .parse(req.query);
    return { incidents: await listIncidents(o.db, { ...(q.status ? { status: q.status as IncidentStatus[] } : {}), limit: q.limit }) };
  });

  app.get('/api/incidents/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const inc = await getIncident(o.db, id);
    return inc ?? reply.status(404).send({ error: 'not_found' });
  });

  app.post('/api/incidents/:id/resolve', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ note: z.string().max(500).optional() }).strict().parse(req.body ?? {});
    const now = new Date();
    const inc = await updateIncident(o.db, id, { status: 'resolved', resolvedAt: now, log: [{ at: now.toISOString(), kind: 'resolved', why: `by you${b.note ? `: ${b.note}` : ''}` }] }, now);
    if (!inc) return reply.status(404).send({ error: 'not_found' });
    await appendEvent(o.db, { kind: 'incident.resolved', subjectType: 'incident', subjectId: id, payload: { by: 'user' } });
    return inc;
  });

  app.get('/api/orchestrator', async () => {
    const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();
    const [spend] = await o.db.execute<{ usd: number; calls: number }>(sql`select coalesce(sum(cost_usd), 0)::float as usd, count(*)::int as calls from llm_calls where created_at >= ${midnight}::timestamptz`);
    const [counts] = await o.db.execute<Record<string, number>>(sql`
      select count(*) filter (where status in ('open','acting'))::int as active, count(*) filter (where status = 'verifying')::int as verifying,
             count(*) filter (where status = 'escalated')::int as escalated, count(*) filter (where status = 'resolved' and resolved_at > now() - interval '7 days')::int as resolved7d
      from incidents`);
    const [fixes] = await o.db.execute<{ merged: number; reverted: number }>(sql`
      select count(*) filter (where e->>'kind' = 'code_fix' and e->>'status' = 'merged')::int as merged, count(*) filter (where e->>'kind' = 'revert' and (e->>'ok')::boolean)::int as reverted
      from incidents, jsonb_array_elements(log) e where (e->>'at')::timestamptz > now() - interval '7 days'`);
    return {
      llm: { todayUsd: spend?.usd ?? 0, calls: spend?.calls ?? 0, budgetUsd: o.budgetUsd ?? null, pausedUntil: (await llmPausedUntil(o.db))?.toISOString() ?? null },
      incidents: counts ?? {},
      codeFixes7d: fixes ?? { merged: 0, reverted: 0 },
      pausedPlugins: await pausedPlugins(o.db),
      tenantOverrides: await tenantOverrides(o.db),
    };
  });

  app.post('/api/orchestrator/run', async (_req, reply) => {
    if (!o.runOrchestrator) return reply.status(503).send({ error: 'the orchestrator is not configured on this server' });
    return o.runOrchestrator();
  });

  app.post('/api/ops/plugins/:id/resume', async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    await setPluginPause(o.db, id, null);
    return { ok: true };
  });

  app.post('/api/ops/llm/resume', async () => {
    await setLlmPausedUntil(o.db, null);
    return { ok: true };
  });

  app.delete('/api/ops/tenant-overrides/:pluginId/:tenant', async (req) => {
    const p = z.object({ pluginId: z.string().min(1).max(100), tenant: z.string().min(1).max(200) }).parse(req.params);
    await setTenantOverride(o.db, p.pluginId, p.tenant, null);
    return { ok: true };
  });
}
