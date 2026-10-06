import { existsSync } from 'node:fs';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import {
  getActiveProfile,
  getJobDetail,
  listCompanyNames,
  listRankedJobs,
  llmUsageSummary,
  matchStats,
  type DB,
} from '@jobforge/db';
import { ConfigError, parseAppConfig, type AppConfig, type Logger } from '@jobforge/shared';
import { OutreachError, type OutreachDeps, type OutreachErrorCode } from '@jobforge/core';
import { registerOutreachRoutes } from './routes-outreach.js';

// Read-only dashboard API (Phase 2). Nothing here causes an external side effect.

const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(item).optional());

export const jobsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    company: z.string().trim().max(200).optional(),
    location: z.string().trim().max(200).optional(),
    remote: csv(z.enum(['remote', 'hybrid', 'onsite'])),
    seniority: csv(z.string().max(20)),
    method: csv(z.enum(['llm', 'prefilter', 'filtered', 'unscored'])),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    sort: z.enum(['score', 'posted']).default('score'),
    closed: z
      .enum(['0', '1', 'true', 'false'])
      .optional()
      .transform((v) => v === '1' || v === 'true'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export type JobsQuery = z.input<typeof jobsQuerySchema>;

export interface ApiOptions {
  db: DB;
  log?: Logger;
  /** Built SPA (apps/web/dist); served at / when present. */
  webDir?: string;
  policy?: AppConfig['outreach'];
  outreachDeps?: () => Promise<OutreachDeps>;
  enqueueFetch?: (companySourceIds: string[]) => Promise<string[]>;
  profileDir?: string;
}

const OUTREACH_STATUS: Record<OutreachErrorCode, number> = {
  not_found: 404,
  invalid_state: 409,
  duplicate: 409,
  company_cap: 409,
  no_email: 422,
  contact_inactive: 422,
  no_profile: 422,
  job_closed: 422,
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The API is for the local dashboard and MCP server only. Requests must name a
 * loopback host (defeats DNS rebinding), and anything that changes state must
 * carry `x-jobforge: 1` from the same origin (defeats cross-site requests: a
 * foreign page can't set that header without a CORS preflight we never allow).
 */
export function requestGuard(host: string | undefined, method: string, origin: string | undefined, marker: unknown): string | null {
  const hostname = (host ?? '').replace(/:\d+$/, '');
  if (!LOOPBACK.has(hostname)) return 'host_not_allowed';
  if (method === 'GET' || method === 'HEAD') return null;
  if (marker !== '1') return 'missing_x_jobforge_header';
  if (origin) {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      return 'bad_origin';
    }
    const devServer = LOOPBACK.has(o.hostname) && o.port === '5173';
    if (o.host !== host && !devServer) return 'cross_origin';
  }
  return null;
}

export async function buildApi(opts: ApiOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ...(opts.log ? { loggerInstance: opts.log as unknown as FastifyBaseLogger } : {}),
    disableRequestLogging: true,
  });
  const { db } = opts;

  app.addHook('onRequest', async (req, reply) => {
    const why = requestGuard(req.headers.host, req.method, req.headers.origin, req.headers['x-jobforge']);
    if (why) return reply.status(403).send({ error: 'forbidden', reason: why });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'bad_request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    if (err instanceof OutreachError) return reply.status(OUTREACH_STATUS[err.code]).send({ error: err.code, message: err.message });
    if (err instanceof ConfigError) return reply.status(422).send({ error: 'invalid', message: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
    if (status === 503) return reply.status(503).send({ error: 'unavailable', message: (err as Error).message });
    app.log.error({ err }, 'request failed');
    return reply.status(500).send({ error: 'internal_error' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/stats', async () => {
    const profile = await getActiveProfile(db);
    return {
      profile: profile ? { version: profile.version, facts: profile.facts.length, roles: profile.preferences.roles } : null,
      match: await matchStats(db, profile?.version ?? null),
      llm24h: await llmUsageSummary(db, new Date(Date.now() - 24 * 3600_000)),
    };
  });

  app.get('/api/profile', async (_req, reply) => {
    const p = await getActiveProfile(db);
    if (!p) return reply.status(404).send({ error: 'no_profile' });
    const { embedding: _e, ...rest } = p;
    return rest;
  });

  app.get('/api/companies', async () => ({ companies: await listCompanyNames(db) }));

  app.get('/api/jobs', async (req) => {
    const q = jobsQuerySchema.parse(req.query);
    const profile = await getActiveProfile(db);
    const { rows, total } = await listRankedJobs(db, {
      profileVersion: profile?.version ?? null,
      ...(q.q ? { q: q.q } : {}),
      ...(q.company ? { company: q.company } : {}),
      ...(q.location ? { location: q.location } : {}),
      ...(q.remote ? { remotePolicy: q.remote } : {}),
      ...(q.seniority ? { seniority: q.seniority } : {}),
      ...(q.method ? { methods: q.method } : {}),
      ...(q.minScore !== undefined ? { minScore: q.minScore } : {}),
      includeClosed: q.closed,
      sort: q.sort,
      limit: q.limit,
      offset: q.offset,
    });
    return { total, profileVersion: profile?.version ?? null, rows };
  });

  app.get('/api/jobs/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const profile = await getActiveProfile(db);
    const job = await getJobDetail(db, id, profile?.version ?? null);
    if (!job) return reply.status(404).send({ error: 'not_found' });
    return job;
  });

  registerOutreachRoutes(app, {
    db,
    policy: opts.policy ?? parseAppConfig({}).outreach,
    ...(opts.outreachDeps ? { outreachDeps: opts.outreachDeps } : {}),
    ...(opts.enqueueFetch ? { enqueueFetch: opts.enqueueFetch } : {}),
    ...(opts.profileDir ? { profileDir: opts.profileDir } : {}),
  });

  app.all('/api/*', async (_req, reply) => reply.status(404).send({ error: 'not_found' }));

  if (opts.webDir && existsSync(opts.webDir)) {
    await app.register(fastifyStatic, { root: opts.webDir, wildcard: false });
    // SPA fallback: every non-API GET serves index.html.
    app.setNotFoundHandler((req, reply) =>
      req.method === 'GET' && !req.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.status(404).send({ error: 'not_found' }),
    );
  }
  return app;
}
