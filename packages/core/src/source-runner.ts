import type { Logger } from '@jobforge/shared';
import { HttpError, rawPostingSchema, type SourceTarget } from '@jobforge/plugin-sdk';
import {
  appendEvent,
  closeStaleJobs,
  finishPluginRun,
  markSourceResult,
  recordPosting,
  startPluginRun,
  type AtsType,
  type DB,
  type SourceTargetRow,
} from '@jobforge/db';
import { normalizePosting } from './normalize.js';
import { buildContext, type ContextDeps, type PluginRegistry } from './plugins.js';

/** Which source plugin serves each ATS type. */
export const SOURCE_PLUGIN_FOR_ATS: Partial<Record<AtsType, string>> = {
  greenhouse: 'source-greenhouse',
  lever: 'source-lever',
};

export interface SourceRunDeps extends Omit<ContextDeps, 'signal' | 'log'> {
  db: DB;
  registry: PluginRegistry;
  log: Logger;
  /** Hard cap on one board fetch. */
  timeoutMs?: number;
}

export interface SourceRunSummary {
  ok: boolean;
  pluginId: string;
  companyName: string;
  boardToken: string;
  postings: number;
  invalid: number;
  jobsCreated: number;
  jobsUpdated: number;
  jobsClosed: number;
  error?: string;
  /** True when retrying can't help (e.g. 404 board). */
  permanent?: boolean;
}

/**
 * Fetch one board end to end: plugin fetch -> validate -> normalize -> dedup
 * upsert -> close stale jobs. Never throws for plugin failures; the result says
 * what happened so one bad board can't take down a batch.
 */
export async function runSourceTarget(deps: SourceRunDeps, row: SourceTargetRow): Promise<SourceRunSummary> {
  const pluginId = SOURCE_PLUGIN_FOR_ATS[row.atsType];
  const summary: SourceRunSummary = {
    ok: false,
    pluginId: pluginId ?? `<none for ${row.atsType}>`,
    companyName: row.companyName,
    boardToken: row.boardToken,
    postings: 0,
    invalid: 0,
    jobsCreated: 0,
    jobsUpdated: 0,
    jobsClosed: 0,
  };
  if (!pluginId) {
    summary.error = `no source plugin for ats_type ${row.atsType}`;
    summary.permanent = true;
    return summary;
  }

  const loaded = deps.registry.source(pluginId);
  const log = deps.log.child({ plugin: pluginId, company: row.companyName, board: row.boardToken });
  const runId = await startPluginRun(deps.db, {
    pluginId,
    stage: 'source',
    targetKey: `${row.atsType}:${row.boardToken}`,
  });
  const startedAt = new Date();
  const signal = AbortSignal.timeout(deps.timeoutMs ?? 5 * 60_000);
  const ctx = buildContext(loaded, { ...deps, log, signal });
  const target: SourceTarget = {
    companySourceId: row.companySourceId,
    companyId: row.companyId,
    companyName: row.companyName,
    boardToken: row.boardToken,
  };

  try {
    for await (const item of loaded.plugin.fetch(ctx, target)) {
      summary.postings++;
      const parsed = rawPostingSchema.safeParse(item);
      if (!parsed.success) {
        summary.invalid++;
        log.warn({ issues: parsed.error.issues.slice(0, 3) }, 'plugin yielded an invalid posting; skipped');
        continue;
      }
      const raw = parsed.data;
      const job = normalizePosting(raw, row.companyName);
      const r = await recordPosting(
        deps.db,
        { ...job, companyId: row.companyId },
        {
          sourcePlugin: pluginId,
          companySourceId: row.companySourceId,
          externalId: raw.externalId,
          url: raw.url,
          payload: raw.payload,
        },
        startedAt,
      );
      if (r.jobCreated) summary.jobsCreated++;
      else summary.jobsUpdated++;
    }

    summary.jobsClosed = await closeStaleJobs(deps.db, row.companyId, row.companySourceId, startedAt);
    summary.ok = true;
    await markSourceResult(deps.db, row.companySourceId, null);
    await finishPluginRun(deps.db, runId, {
      status: 'succeeded',
      itemsIn: summary.postings,
      itemsOut: summary.jobsCreated + summary.jobsUpdated,
      meta: { created: summary.jobsCreated, updated: summary.jobsUpdated, closed: summary.jobsClosed, invalid: summary.invalid },
    });
    await appendEvent(deps.db, {
      kind: 'source.run.succeeded',
      subjectType: 'company_source',
      subjectId: row.companySourceId,
      payload: { runId, pluginId, ...pick(summary) },
    });
    log.info(pick(summary), 'board fetched');
  } catch (err) {
    summary.error = errorMessage(err);
    summary.permanent = err instanceof HttpError && err.permanent;
    await markSourceResult(deps.db, row.companySourceId, summary.error);
    await finishPluginRun(deps.db, runId, {
      status: 'failed',
      itemsIn: summary.postings,
      itemsOut: summary.jobsCreated + summary.jobsUpdated,
      error: summary.error,
    });
    await appendEvent(deps.db, {
      kind: 'source.run.failed',
      subjectType: 'company_source',
      subjectId: row.companySourceId,
      payload: { runId, pluginId, error: summary.error, permanent: summary.permanent },
    });
    log.warn({ err: summary.error, permanent: summary.permanent }, 'board fetch failed');
  }
  return summary;
}

function pick(s: SourceRunSummary) {
  return { postings: s.postings, created: s.jobsCreated, updated: s.jobsUpdated, closed: s.jobsClosed, invalid: s.invalid };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.name === 'Error' ? err.message : `${err.name}: ${err.message}`;
  return String(err);
}
