import { createReviewItem, getCompanySource, setCompanySourceStatus, type DB } from '@jobforge/db';
import { setLlmPausedUntil, setPluginPause, setTenantOverride, withTenantOverrides, type PluginRegistry } from '@jobforge/core';
import type { Logger } from '@jobforge/shared';
import type { PlannedAction } from './experts.js';

// Phase 22: ops actions (no code). Each is checked against its own bounds here,
// whatever the expert proposed: pauses last at most a week, tenant overrides
// must validate against the actor's own config schema, jobs and boards must
// exist. Nothing here sends, submits or approves anything.

export interface OpsDeps {
  db: DB;
  log: Logger;
  /** Validates tenant overrides against the actor's schema. */
  registry?: PluginRegistry;
  enqueueFetch?: (companySourceIds: string[]) => Promise<unknown>;
  runStage?: (stage: 'sweep' | 'match' | 'apply' | 'deadlines') => Promise<unknown>;
  advanceJob?: (jobId: string) => Promise<unknown>;
  expireJob?: (jobId: string, reason: string) => Promise<unknown>;
  topUpReferrals?: (jobId: string) => Promise<unknown>;
  now?: () => Date;
}

export interface ActionOutcome {
  type: PlannedAction['type'];
  ok: boolean;
  detail: string;
  /** raise_attention: the review item id. */
  attentionId?: string;
}

const MAX_PAUSE_HOURS = 168;

/** Next UTC midnight. */
export const nextUtcMidnight = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

export async function raiseAttention(db: DB, a: { title: string; message: string; incidentId?: string; url?: string | null }): Promise<string> {
  const item = await createReviewItem(db, {
    kind: 'attention',
    pluginId: 'orchestrator',
    jobId: null,
    contactId: null,
    companyId: null,
    draft: { title: a.title.slice(0, 200), message: a.message.slice(0, 4000), reason: 'incident', url: a.url ?? null, ...(a.incidentId ? { incidentId: a.incidentId } : {}) },
  });
  return item.id;
}

export async function executeAction(deps: OpsDeps, a: PlannedAction, incidentId?: string): Promise<ActionOutcome> {
  const now = deps.now?.() ?? new Date();
  const fail = (detail: string): ActionOutcome => ({ type: a.type, ok: false, detail });
  const done = (detail: string, extra: Partial<ActionOutcome> = {}): ActionOutcome => ({ type: a.type, ok: true, detail, ...extra });
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined || v === null || v === '') throw new Error(`${a.type} needs ${what}`);
    return v;
  };
  try {
    switch (a.type) {
      case 'requeue_source':
      case 'pause_source':
      case 'resume_source': {
        const id = need(a.companySourceId, 'companySourceId');
        const src = await getCompanySource(deps.db, id);
        if (!src) return fail(`no board ${id}`);
        if (a.type === 'requeue_source') {
          if (!deps.enqueueFetch) return fail('no fetch queue available');
          await deps.enqueueFetch([id]);
          return done(`fetch of ${src.atsType}/${src.boardToken} queued`);
        }
        const status = a.type === 'pause_source' ? 'paused' : 'active';
        await setCompanySourceStatus(deps.db, id, status, a.type === 'pause_source' ? `paused by the orchestrator: ${(a.reason ?? '').slice(0, 300)}` : undefined);
        return done(`board ${src.atsType}/${src.boardToken} ${status}`);
      }
      case 'pause_plugin': {
        const id = need(a.pluginId, 'pluginId');
        if (deps.registry && !deps.registry.list().some((p) => p.manifest.id === id)) return fail(`no plugin ${id}`);
        const hours = Math.min(Math.max(a.hours ?? 24, 1), MAX_PAUSE_HOURS);
        await setPluginPause(deps.db, id, { until: new Date(now.getTime() + hours * 3600_000), reason: a.reason ?? 'orchestrator' }, now);
        return done(`${id} paused for ${hours} h`);
      }
      case 'resume_plugin': {
        await setPluginPause(deps.db, need(a.pluginId, 'pluginId'), null, now);
        return done(`${a.pluginId} resumed`);
      }
      case 'set_tenant_override': {
        const pluginId = need(a.pluginId, 'pluginId');
        const tenant = need(a.tenant, 'tenant');
        let override: Record<string, unknown>;
        try {
          override = JSON.parse(need(a.overrideJson, 'overrideJson')) as Record<string, unknown>;
        } catch {
          return fail('overrideJson is not valid JSON');
        }
        if (!deps.registry) return fail('no plugin registry to validate the override');
        const loaded = deps.registry.list().find((p) => p.manifest.id === pluginId);
        if (!loaded) return fail(`no plugin ${pluginId}`);
        const r = withTenantOverrides(loaded, { [tenant]: override });
        if (r.error || r.loaded === loaded) return fail(`override rejected by ${pluginId}'s config schema: ${r.error ?? 'the plugin has no tenant overrides'}`);
        await setTenantOverride(deps.db, pluginId, tenant, override);
        return done(`${pluginId} override for tenant ${tenant} saved`);
      }
      case 'advance_job':
        if (!deps.advanceJob) return fail('advancing jobs is not available');
        await deps.advanceJob(need(a.jobId, 'jobId'));
        return done(`job ${a.jobId} advanced`);
      case 'expire_job':
        if (!deps.expireJob) return fail('expiring jobs is not available');
        await deps.expireJob(need(a.jobId, 'jobId'), a.reason ?? 'closed by the orchestrator');
        return done(`job ${a.jobId} expired`);
      case 'top_up_referrals':
        if (!deps.topUpReferrals) return fail('referral top-up is not available');
        await deps.topUpReferrals(need(a.jobId, 'jobId'));
        return done(`referral batch for ${a.jobId} topped up (drafts wait for review)`);
      case 'rerun_stage':
        if (!deps.runStage) return fail('re-running stages is not available');
        await deps.runStage(need(a.stage, 'stage'));
        return done(`${a.stage} re-run`);
      case 'pause_llm': {
        const until = nextUtcMidnight(now);
        await setLlmPausedUntil(deps.db, until);
        return done(`LLM steps paused until ${until.toISOString()}`);
      }
      case 'raise_attention': {
        const id = await raiseAttention(deps.db, { title: a.title ?? 'JobForge needs you', message: a.message ?? a.reason ?? '', ...(incidentId ? { incidentId } : {}) });
        return done('attention item raised', { attentionId: id });
      }
      case 'code_fix':
        return fail('code fixes run through the code-fix pipeline, not as an ops action');
    }
  } catch (err) {
    return fail((err as Error).message);
  }
}
