import type { Logger } from '@jobforge/shared';
import { rawPostingSchema, type SourceTarget } from '@jobforge/plugin-sdk';
import {
  appendEvent,
  finishPluginRun,
  getState,
  listAllCompanies,
  recordPosting,
  setState,
  startPluginRun,
  upsertCompany,
  type DB,
} from '@jobforge/db';
import type { GmailHandle } from '@jobforge/plugin-sdk';
import { companyMatchKey, normalizePosting } from './normalize.js';
import { buildContext, type ContextDeps, type PluginRegistry } from './plugins.js';

export const ALERT_SOURCE_ID = 'source-gmail-alerts';
const CURSOR_KEY = `${ALERT_SOURCE_ID}.cursor`;

export interface AlertRunDeps extends Omit<ContextDeps, 'signal' | 'log'> {
  db: DB;
  registry: PluginRegistry;
  log: Logger;
  gmail: GmailHandle;
  timeoutMs?: number;
}

export interface AlertRunSummary {
  ok: boolean;
  postings: number;
  invalid: number;
  jobsCreated: number;
  jobsUpdated: number;
  companiesCreated: number;
  parseFailures: number;
  since: string;
  error?: string;
}

/**
 * Run the job-alert source (PLAN Phase 7). Unlike board sources it isn't tied
 * to one company: each posting names its employer, which is matched to a
 * known company (loosely: "Walmart Global Tech India" → "Walmart Global Tech")
 * or created. Postings dedupe into canonical jobs through the usual
 * fingerprint. Alerts never close jobs. A cursor in app_state makes reruns cheap.
 */
export async function runAlertSource(deps: AlertRunDeps, opts: { since?: Date } = {}): Promise<AlertRunSummary> {
  const loaded = deps.registry.source(ALERT_SOURCE_ID);
  const cursor = await getState<{ at: string }>(deps.db, CURSOR_KEY);
  // Re-read a day of overlap: Gmail's after: is day-granular for some clients and alerts arrive late.
  const since = opts.since ?? (cursor ? new Date(new Date(cursor.at).getTime() - 24 * 3600_000) : undefined);
  const summary: AlertRunSummary = {
    ok: false,
    postings: 0,
    invalid: 0,
    jobsCreated: 0,
    jobsUpdated: 0,
    companiesCreated: 0,
    parseFailures: 0,
    since: since?.toISOString() ?? 'lookback',
  };
  const log = deps.log.child({ plugin: ALERT_SOURCE_ID });
  const runId = await startPluginRun(deps.db, { pluginId: ALERT_SOURCE_ID, stage: 'source', targetKey: 'inbox' });
  const startedAt = new Date();
  const pendingEvents: { kind: string; data: Record<string, unknown> }[] = [];
  const ctx = buildContext(loaded, {
    ...deps,
    log,
    signal: AbortSignal.timeout(deps.timeoutMs ?? 10 * 60_000),
    onEvent: (kind, data) => pendingEvents.push({ kind, data }),
  });
  const target: SourceTarget = {
    companySourceId: '',
    companyId: '',
    companyName: '',
    boardToken: 'inbox',
    ...(since ? { options: { since: since.toISOString() } } : {}),
  };

  // Known companies by loose key, so alert names land on the boards we already fetch.
  const known = new Map<string, { id: string; name: string }>();
  for (const c of await listAllCompanies(deps.db)) known.set(companyMatchKey(c.name), c);

  try {
    for await (const item of loaded.plugin.fetch(ctx, target)) {
      summary.postings++;
      const parsed = rawPostingSchema.safeParse(item);
      if (!parsed.success || !parsed.data.companyName) {
        summary.invalid++;
        continue;
      }
      const raw = parsed.data;
      const key = companyMatchKey(raw.companyName!);
      let company = known.get(key);
      if (!company) {
        const c = await upsertCompany(deps.db, { name: raw.companyName!, discoveredVia: 'gmail-alert' });
        company = { id: c.id, name: raw.companyName! };
        known.set(key, company);
        if (c.created) summary.companiesCreated++;
      }
      const job = normalizePosting(raw, company.name);
      const r = await recordPosting(
        deps.db,
        { ...job, companyId: company.id },
        { sourcePlugin: ALERT_SOURCE_ID, companySourceId: null, externalId: raw.externalId, url: raw.url, payload: raw.payload },
        startedAt,
      );
      if (r.jobCreated) summary.jobsCreated++;
      else summary.jobsUpdated++;
    }
    summary.ok = true;
    await setState(deps.db, CURSOR_KEY, { at: startedAt.toISOString() });
  } catch (err) {
    summary.error = err instanceof Error ? err.message : String(err);
    log.warn({ err: summary.error }, 'alert source failed');
  }
  summary.parseFailures = pendingEvents.filter((e) => e.kind.endsWith('.parse_failed')).length;
  for (const e of pendingEvents) {
    await appendEvent(deps.db, { kind: e.kind, subjectType: 'plugin', subjectId: ALERT_SOURCE_ID, payload: { runId, ...e.data } });
  }
  await finishPluginRun(deps.db, runId, {
    status: summary.ok ? 'succeeded' : 'failed',
    itemsIn: summary.postings,
    itemsOut: summary.jobsCreated + summary.jobsUpdated,
    ...(summary.error ? { error: summary.error } : {}),
    meta: { ...summary },
  });
  await appendEvent(deps.db, {
    kind: summary.ok ? 'source.run.succeeded' : 'source.run.failed',
    subjectType: 'plugin',
    subjectId: ALERT_SOURCE_ID,
    payload: { runId, ...summary },
  });
  return summary;
}
