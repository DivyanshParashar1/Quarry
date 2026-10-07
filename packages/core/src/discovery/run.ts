import type { LLMClient, Logger } from '@jobforge/shared';
import { appendEvent, findCompanyByDomain, findCompanyByName, finishPluginRun, startPluginRun, type DB } from '@jobforge/db';
import { discoverAndSave } from './discover-ats.js';
import { COMPANY_LISTS, dedupeCandidates, type CompanyCandidate, type ListSettings } from './lists.js';
import type { PageFetcher } from './page-fetcher.js';
import type { AtsDetection } from './detect.js';

export interface DiscoverCompaniesDeps {
  db: DB;
  pages: PageFetcher;
  llm?: LLMClient | undefined;
  log: Logger;
}

export interface DiscoverCompaniesOptions {
  list: string;
  settings?: ListSettings;
  /** Stop after adding this many new companies (default 100). */
  maxNew?: number;
  minConfidence?: number;
  /** Detect but write nothing. */
  dryRun?: boolean;
  /** Parallel discover_ats calls (each is rate-limited per host anyway). */
  concurrency?: number;
}

export interface DiscoveredCompanyRow {
  name: string;
  domain: string | null;
  best: AtsDetection | null;
  created: boolean;
  error?: string;
}

export interface DiscoverCompaniesSummary {
  list: string;
  candidates: number;
  unique: number;
  existing: number;
  added: number;
  withAts: number;
  withoutAts: number;
  errors: string[];
  companies: DiscoveredCompanyRow[];
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

/**
 * PLAN Phase 6 `discover_companies --list <id>`: crawl a public company list,
 * drop companies we already know (by domain, then name), run `discover_ats`
 * on each new one, and save company + boards atomically.
 */
export async function runDiscoverCompanies(
  deps: DiscoverCompaniesDeps,
  opts: DiscoverCompaniesOptions,
): Promise<DiscoverCompaniesSummary> {
  const source = COMPANY_LISTS[opts.list];
  if (!source) throw new Error(`unknown list "${opts.list}" (known: ${Object.keys(COMPANY_LISTS).join(', ')})`);
  const summary: DiscoverCompaniesSummary = {
    list: opts.list,
    candidates: 0,
    unique: 0,
    existing: 0,
    added: 0,
    withAts: 0,
    withoutAts: 0,
    errors: [],
    companies: [],
  };
  const runId = await startPluginRun(deps.db, { pluginId: `discovery:${opts.list}`, stage: 'discovery', targetKey: opts.list });
  try {
    const raw = await source.collect(deps, opts.settings ?? {});
    summary.candidates = raw.length;
    const unique = dedupeCandidates(raw);
    summary.unique = unique.length;

    const fresh: CompanyCandidate[] = [];
    for (const c of unique) {
      const known = (c.domain ? await findCompanyByDomain(deps.db, c.domain) : null) ?? (await findCompanyByName(deps.db, c.name));
      if (known) summary.existing++;
      else fresh.push(c);
    }
    const todo = fresh.slice(0, opts.maxNew ?? 100);

    await pool(todo, opts.concurrency ?? 4, async (c) => {
      try {
        const r = await discoverAndSave(
          deps,
          { name: c.name, domain: c.domain ?? undefined, tags: c.tags, location: c.location, discoveredVia: `list:${opts.list}` },
          { ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}), ...(opts.dryRun ? { dryRun: true } : {}) },
        );
        const created = r.saved?.companyCreated ?? false;
        if (created || opts.dryRun) summary.added++;
        if (r.best) summary.withAts++;
        else summary.withoutAts++;
        summary.companies.push({ name: c.name, domain: r.domain, best: r.best, created });
      } catch (err) {
        const msg = `${c.name}: ${(err as Error).message}`;
        summary.errors.push(msg);
        summary.companies.push({ name: c.name, domain: c.domain, best: null, created: false, error: msg });
      }
    });

    await finishPluginRun(deps.db, runId, {
      status: 'succeeded',
      itemsIn: summary.candidates,
      itemsOut: summary.added,
      meta: { ...summary, companies: undefined },
    });
    await appendEvent(deps.db, {
      kind: 'discovery.run',
      subjectType: 'list',
      subjectId: opts.list,
      payload: { runId, dryRun: !!opts.dryRun, ...summary, companies: summary.companies.slice(0, 200).map((c) => ({ name: c.name, ats: c.best?.atsType ?? null })) },
    });
  } catch (err) {
    summary.errors.push((err as Error).message);
    await finishPluginRun(deps.db, runId, { status: 'failed', itemsIn: summary.candidates, itemsOut: summary.added, error: (err as Error).message });
    await appendEvent(deps.db, { kind: 'discovery.run.failed', subjectType: 'list', subjectId: opts.list, payload: { runId, error: (err as Error).message } });
  }
  return summary;
}
