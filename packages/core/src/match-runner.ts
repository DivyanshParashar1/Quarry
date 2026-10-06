import type { Logger } from '@jobforge/shared';
import type { Job, MatchResult } from '@jobforge/plugin-sdk';
import {
  appendEvent,
  finishPluginRun,
  getActiveProfile,
  jobsToMatch,
  saveMatchResults,
  startPluginRun,
  type DB,
} from '@jobforge/db';
import { buildContext, type ContextDeps, type PluginRegistry } from './plugins.js';

export interface MatchRunDeps extends Omit<ContextDeps, 'signal' | 'log'> {
  db: DB;
  registry: PluginRegistry;
  log: Logger;
  timeoutMs?: number;
}

export interface MatchRunSummary {
  pluginId: string;
  profileVersion: string;
  candidates: number;
  llm: number;
  prefilter: number;
  filtered: number;
  /** Candidates with no result this run (not embedded yet, or an LLM batch failed); retried next run. */
  unscored: number;
}

export class NoProfileError extends Error {
  constructor() {
    super('No profile loaded. Fill in profile/*.yaml and run `jf profile load`.');
  }
}

/**
 * Score open jobs that have no result for the active profile version. Results
 * are upserted, so an interrupted run resumes where it stopped.
 */
export async function runMatch(
  deps: MatchRunDeps,
  opts: { pluginId?: string; rescore?: boolean; limit?: number; jobIds?: string[] } = {},
): Promise<MatchRunSummary> {
  const pluginId = opts.pluginId ?? 'matcher-default';
  const loaded = deps.registry.matcher(pluginId);
  const profile = await getActiveProfile(deps.db);
  if (!profile) throw new NoProfileError();

  const rows = await jobsToMatch(deps.db, profile.version, {
    ...(opts.rescore ? { rescore: true } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.jobIds ? { jobIds: opts.jobIds } : {}),
  });
  const summary: MatchRunSummary = {
    pluginId,
    profileVersion: profile.version,
    candidates: rows.length,
    llm: 0,
    prefilter: 0,
    filtered: 0,
    unscored: 0,
  };
  if (!rows.length) return summary;

  const log = deps.log.child({ plugin: pluginId, profileVersion: profile.version });
  const runId = await startPluginRun(deps.db, { pluginId, stage: 'matcher', targetKey: `profile:${profile.version}` });
  const signal = AbortSignal.timeout(deps.timeoutMs ?? 60 * 60_000);
  const ctx = buildContext(loaded, { ...deps, log, signal });
  const jobs: Job[] = rows;

  try {
    const results = validResults(await loaded.plugin.score(ctx, jobs, profile), new Set(rows.map((r) => r.id)), log);
    await saveMatchResults(deps.db, profile.version, pluginId, results);
    for (const r of results) summary[r.method]++;
    summary.unscored = rows.length - results.length;
    await finishPluginRun(deps.db, runId, {
      status: 'succeeded',
      itemsIn: rows.length,
      itemsOut: results.length,
      meta: { ...summary },
    });
    await appendEvent(deps.db, { kind: 'match.run.succeeded', subjectType: 'profile', subjectId: profile.version, payload: { runId, ...summary } });
    log.info(summary, 'match run finished');
    return summary;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await finishPluginRun(deps.db, runId, { status: 'failed', itemsIn: rows.length, itemsOut: 0, error });
    await appendEvent(deps.db, { kind: 'match.run.failed', subjectType: 'profile', subjectId: profile.version, payload: { runId, error } });
    throw err;
  }
}

/** Drop results for jobs we didn't ask about, duplicates, and out-of-range scores. */
function validResults(results: MatchResult[], asked: Set<string>, log: Logger): MatchResult[] {
  const seen = new Set<string>();
  const out: MatchResult[] = [];
  for (const r of results) {
    if (!asked.has(r.jobId) || seen.has(r.jobId) || !(r.score >= 0 && r.score <= 100)) {
      log.warn({ jobId: r.jobId, score: r.score }, 'matcher returned an invalid result; dropped');
      continue;
    }
    seen.add(r.jobId);
    out.push(r);
  }
  return out;
}
