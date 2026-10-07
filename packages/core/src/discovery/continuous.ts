import type { AppConfig, LLMClient, Logger } from '@jobforge/shared';
import {
  addCompanySource,
  appendEvent,
  finishPluginRun,
  lastSuccessfulPostings,
  listCompaniesForAtsCheck,
  markAtsChecked,
  markSourceStale,
  newSourceIdsSince,
  startPluginRun,
  type DB,
} from '@jobforge/db';
import { discoverAts } from './discover-ats.js';
import { COMPANY_LISTS } from './lists.js';
import type { PageFetcher } from './page-fetcher.js';
import { runDiscoverCompanies, type DiscoverCompaniesSummary } from './run.js';

const DAY = 86_400_000;

export interface ContinuousDeps {
  db: DB;
  pages: PageFetcher;
  llm?: LLMClient | undefined;
  log: Logger;
  /** Queue fetches for the boards discovery just added (the server's pg-boss). */
  enqueueFetch?: (companySourceIds: string[]) => Promise<string[]>;
  now?: () => Date;
}

export interface NightlySummary {
  lists: (Pick<DiscoverCompaniesSummary, 'list' | 'candidates' | 'added' | 'withAts' | 'withoutAts' | 'existing'> & { errors: number })[];
  added: number;
  newSources: number;
  queuedFetches: number;
}

/**
 * PLAN Phase 13: crawl every enabled company list, add new companies with
 * their detected boards, and queue those boards for fetching right away.
 * Lists that need an LLM are skipped when none is configured.
 */
export async function runNightlyDiscovery(deps: ContinuousDeps, config: AppConfig['discovery']): Promise<NightlySummary> {
  const started = deps.now?.() ?? new Date();
  const out: NightlySummary = { lists: [], added: 0, newSources: 0, queuedFetches: 0 };
  for (const [id, source] of Object.entries(COMPANY_LISTS)) {
    const settings = config.lists[id];
    if (settings?.enabled === false) continue;
    if (source.needsLlm && !deps.llm) {
      deps.log.info({ list: id }, 'nightly discovery: list needs an LLM; skipped');
      continue;
    }
    const s = await runDiscoverCompanies(
      { db: deps.db, pages: deps.pages, llm: deps.llm, log: deps.log },
      { list: id, settings: { urls: settings?.urls, regions: settings?.regions }, maxNew: settings?.maxNew ?? 50, minConfidence: config.minConfidence },
    );
    out.lists.push({ list: s.list, candidates: s.candidates, added: s.added, withAts: s.withAts, withoutAts: s.withoutAts, existing: s.existing, errors: s.errors.length });
    out.added += s.added;
  }
  const ids = await newSourceIdsSince(deps.db, started);
  out.newSources = ids.length;
  if (ids.length && deps.enqueueFetch) out.queuedFetches = (await deps.enqueueFetch(ids)).length;
  await appendEvent(deps.db, { kind: 'discovery.nightly', payload: { ...out } });
  return out;
}

export interface RecheckResult {
  companyId: string;
  name: string;
  added: { atsType: string; boardToken: string }[];
  stale: { sourceId: string; atsType: string; boardToken: string | null; reason: string }[];
  error?: string;
}

export interface RecheckSummary {
  checked: number;
  newSources: number;
  staleSources: number;
  results: RecheckResult[];
}

/**
 * PLAN Phase 13 "company ATS re-check" (run daily over companies whose last
 * check is older than `recheckDays`, so each one is looked at monthly):
 * re-detect the ATS; add newly found boards; when the company now points at a
 * different board AND an old board is failing or empty, mark the old one
 * stale (paused, never deleted) — e.g. a silent Greenhouse → Workday move.
 */
export async function runAtsRecheck(
  deps: ContinuousDeps,
  config: AppConfig['discovery'],
  opts: { limit?: number } = {},
): Promise<RecheckSummary> {
  const now = deps.now?.() ?? new Date();
  const due = await listCompaniesForAtsCheck(deps.db, { checkedBefore: new Date(now.getTime() - config.recheckDays * DAY), limit: opts.limit ?? 50 });
  const runId = await startPluginRun(deps.db, { pluginId: 'enricher-company-ats-recheck', stage: 'enricher', targetKey: 'recheck' });
  const out: RecheckSummary = { checked: 0, newSources: 0, staleSources: 0, results: [] };
  for (const c of due) {
    const r: RecheckResult = { companyId: c.id, name: c.name, added: [], stale: [] };
    try {
      const d = await discoverAts({ pages: deps.pages, log: deps.log }, { name: c.name, ...(c.domain ? { domain: c.domain } : {}) });
      out.checked++;
      // Name-probe hits can be a different company with the same slug: they only
      // count for companies that have no working board at all.
      const hasActive = c.sources.some((s) => s.status === 'active');
      const confident = d.detections.filter((x) => x.confidence >= config.minConfidence && (!x.evidence.startsWith('probe:') || !hasActive));
      const key = (a: string, t: string | null) => `${a}:${(t ?? '').toLowerCase()}`;
      const existing = new Set(c.sources.map((s) => key(s.atsType, s.boardToken)));
      for (const det of confident) {
        if (existing.has(key(det.atsType, det.boardToken))) continue;
        if (await addCompanySource(deps.db, { companyId: c.id, atsType: det.atsType, boardToken: det.boardToken, detectedBy: 'recheck' })) {
          r.added.push({ atsType: det.atsType, boardToken: det.boardToken });
        }
      }
      // Moved? Only when the site now points somewhere else AND the old board stopped working.
      if (confident.length) {
        const pointsAt = new Set(confident.map((x) => key(x.atsType, x.boardToken)));
        for (const s of c.sources) {
          if (s.status === 'paused' || pointsAt.has(key(s.atsType, s.boardToken))) continue;
          const lastPostings = s.boardToken ? await lastSuccessfulPostings(deps.db, s.atsType, s.boardToken) : null;
          const failing = s.status === 'error' || lastPostings === 0;
          if (!failing) continue;
          const reason = `careers site now points at ${confident[0]!.atsType}:${confident[0]!.boardToken}; this board is ${s.status === 'error' ? 'failing' : 'empty'}`;
          await markSourceStale(deps.db, s.id, reason);
          r.stale.push({ sourceId: s.id, atsType: s.atsType, boardToken: s.boardToken, reason });
        }
      }
      await markAtsChecked(deps.db, c.id, now);
    } catch (err) {
      r.error = err instanceof Error ? err.message : String(err);
      await markAtsChecked(deps.db, c.id, now);
    }
    out.newSources += r.added.length;
    out.staleSources += r.stale.length;
    if (r.added.length || r.stale.length || r.error) out.results.push(r);
    if (r.added.length || r.stale.length) {
      await appendEvent(deps.db, { kind: 'discovery.recheck', subjectType: 'company', subjectId: c.id, payload: { added: r.added, stale: r.stale } });
    }
  }
  const ids = out.newSources ? await newSourceIdsSince(deps.db, now) : [];
  if (ids.length && deps.enqueueFetch) await deps.enqueueFetch(ids);
  await finishPluginRun(deps.db, runId, { status: 'succeeded', itemsIn: due.length, itemsOut: out.newSources, meta: { stale: out.staleSources } });
  return out;
}
