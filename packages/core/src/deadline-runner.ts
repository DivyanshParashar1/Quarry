import type { AppConfig, Logger } from '@jobforge/shared';
import type { DeadlineEstimate } from '@jobforge/plugin-sdk';
import {
  appendEvent,
  closeExpiredDeadlines,
  finishPluginRun,
  getActiveProfile,
  jobsNeedingDeadline,
  jobsToMatch,
  saveDeadline,
  startPluginRun,
  type DB,
} from '@jobforge/db';
import { loadCompanyRef } from './contacts-runner.js';
import { buildContext, type ContextDeps, type PluginRegistry } from './plugins.js';

export const DEADLINE_ENRICHER = 'enricher-deadline';
const DAY = 86_400_000;

export interface DeadlineDeps extends Omit<ContextDeps, 'signal' | 'log'> {
  db: DB;
  registry: PluginRegistry;
  log: Logger;
  policy: AppConfig['deadlines'];
  now?: () => Date;
}

export interface DeadlineRunSummary {
  considered: number;
  estimated: number;
  withDate: number;
  failed: { jobId: string; error: string }[];
  expired: string[];
}

/**
 * PLAN Phase 10: estimate application close dates for well-matched open jobs
 * (stale after `staleDays`), then close jobs whose confident deadline has
 * passed. Failures are per job and never stop the batch.
 */
export async function runDeadlines(
  deps: DeadlineDeps,
  opts: { jobIds?: string[]; limit?: number; force?: boolean } = {},
): Promise<DeadlineRunSummary> {
  const now = deps.now?.() ?? new Date();
  const profile = await getActiveProfile(deps.db);
  const todo = await jobsNeedingDeadline(deps.db, {
    profileVersion: profile?.version ?? null,
    minScore: deps.policy.minMatchScore,
    staleBefore: opts.force ? new Date(now.getTime() + DAY) : new Date(now.getTime() - deps.policy.staleDays * DAY),
    limit: opts.limit ?? deps.policy.batchSize,
    ...(opts.jobIds ? { jobIds: opts.jobIds } : {}),
  });
  const summary: DeadlineRunSummary = { considered: todo.length, estimated: 0, withDate: 0, failed: [], expired: [] };
  const loaded = deps.registry.enricher(DEADLINE_ENRICHER);
  const runId = await startPluginRun(deps.db, { pluginId: DEADLINE_ENRICHER, stage: 'enricher', targetKey: opts.jobIds ? 'jobs' : 'batch' });
  for (const { id } of todo) {
    const [job] = await jobsToMatch(deps.db, '', { rescore: true, jobIds: [id] });
    if (!job) continue;
    const company = await loadCompanyRef(deps.db, job.companyId);
    if (!company) continue;
    const log = deps.log.child({ plugin: DEADLINE_ENRICHER, jobId: id });
    try {
      const ctx = buildContext(loaded, { ...deps, log, signal: AbortSignal.timeout(5 * 60_000) });
      const e = (await loaded.plugin.enrich(ctx, job, company)) as unknown as DeadlineEstimate;
      await saveDeadline(deps.db, id, e, now);
      summary.estimated++;
      if (e.deadline) summary.withDate++;
      await appendEvent(deps.db, {
        kind: 'job.deadline_inferred',
        subjectType: 'job',
        subjectId: id,
        payload: { deadline: e.deadline, confidence: e.confidence, searched: e.searched, sources: e.sources.length },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      summary.failed.push({ jobId: id, error });
      log.warn({ err: error }, 'deadline estimate failed');
    }
  }
  summary.expired = await expireDeadlines(deps.db, deps.policy, now);
  await finishPluginRun(deps.db, runId, {
    status: 'succeeded',
    itemsIn: summary.considered,
    itemsOut: summary.estimated,
    meta: { withDate: summary.withDate, failed: summary.failed.length, expired: summary.expired.length },
  });
  return summary;
}

/** Close jobs whose inferred deadline passed (confidently); they drop out of the autopilot. */
export async function expireDeadlines(db: DB, policy: AppConfig['deadlines'], now = new Date()): Promise<string[]> {
  const closed = await closeExpiredDeadlines(db, now.toISOString().slice(0, 10), {
    minConfidence: policy.expireMinConfidence,
    graceDays: policy.expireGraceDays,
  });
  for (const { id } of closed) await appendEvent(db, { kind: 'job.expired', subjectType: 'job', subjectId: id, payload: { reason: 'inferred deadline passed' } });
  return closed.map((c) => c.id);
}

/**
 * The Phase 12 "deadline near" predicate: inferred_deadline − now < `days`.
 * Low-confidence guesses don't count as imminent.
 */
export function isDeadlineImminent(
  job: { inferredDeadline: string | Date | null; deadlineConfidence: number | null },
  now: Date,
  days: number,
  minConfidence = 0.4,
): boolean {
  if (!job.inferredDeadline || (job.deadlineConfidence ?? 0) < minConfidence) return false;
  const d = typeof job.inferredDeadline === 'string' ? new Date(`${job.inferredDeadline}T23:59:59Z`) : job.inferredDeadline;
  return d.getTime() - now.getTime() < days * DAY;
}
