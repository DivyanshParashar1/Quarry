import type { Logger } from '@jobforge/shared';
import { saveDiscoveredCompany, type DB, type SaveDiscoveredResult } from '@jobforge/db';
import { careerLinks, classifyUrl, normalizeDomain, scanHtml, slugCandidates, type AtsDetection } from './detect.js';
import { RobotsDisallowedError, type PageFetcher } from './page-fetcher.js';

/** Paths tried on the company's own domain (PLAN Phase 6 + two common subdomains). */
export const CAREERS_PATHS = ['/careers', '/jobs', '/join-us'];
export const CAREERS_SUBDOMAINS = ['careers', 'jobs'];

export interface DiscoverAtsInput {
  /** Company name; used for name-based API probes when the domain gives nothing. */
  name?: string | undefined;
  /** Bare domain or URL. */
  domain?: string | undefined;
}

export interface DiscoverAtsOptions {
  /** Probe ATS APIs with slugs derived from the name (default true). */
  probe?: boolean;
  /** Follow up to this many same-site "jobs"/"careers" links one hop deeper (default 3). */
  followLinks?: number;
}

export interface DiscoverAtsResult {
  input: DiscoverAtsInput;
  domain: string | null;
  /** All boards found, best first. */
  detections: AtsDetection[];
  best: AtsDetection | null;
  visited: string[];
  robotsBlocked: string[];
  errors: string[];
}

const TYPE_PREFERENCE = ['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'successfactors', 'taleo'];

function rank(a: AtsDetection, b: AtsDetection): number {
  return b.confidence - a.confidence || TYPE_PREFERENCE.indexOf(a.atsType) - TYPE_PREFERENCE.indexOf(b.atsType);
}

/**
 * Detect which ATS a company uses (PLAN Phase 6 `discover_ats`):
 *  1. fetch {domain}/careers, /jobs, /join-us (and careers./jobs. subdomains),
 *     robots.txt respected; a redirect onto an ATS host is the strongest signal;
 *  2. scan the pages for ATS links/embeds, following a few same-site job links;
 *  3. failing that, probe the public ATS APIs with slugs derived from the name.
 */
export async function discoverAts(
  deps: { pages: PageFetcher; log: Logger },
  input: DiscoverAtsInput,
  opts: DiscoverAtsOptions = {},
): Promise<DiscoverAtsResult> {
  const domain = input.domain ? normalizeDomain(input.domain) : null;
  const res: DiscoverAtsResult = { input, domain, detections: [], best: null, visited: [], robotsBlocked: [], errors: [] };
  const found = new Map<string, AtsDetection>();
  const add = (d: AtsDetection) => {
    const k = `${d.atsType}:${d.boardToken}`;
    const cur = found.get(k);
    if (!cur || cur.confidence < d.confidence) found.set(k, d);
  };

  const visit = async (url: string): Promise<{ body: string; url: string } | null> => {
    try {
      const page = await deps.pages.get(url);
      res.visited.push(...page.chain.filter((u) => !res.visited.includes(u)));
      // A redirect chain that lands on (or passes through) an ATS host.
      for (const hop of page.chain) {
        const d = classifyUrl(hop);
        if (d) add({ ...d, evidence: `${url} → ${hop}`, confidence: 1 });
      }
      if (page.status >= 400) return null;
      if (!/html|text\/plain|xml/i.test(page.contentType) && page.contentType) return null;
      for (const d of scanHtml(page.body, page.url)) add(d);
      return { body: page.body, url: page.url };
    } catch (err) {
      if (err instanceof RobotsDisallowedError) res.robotsBlocked.push(err.url);
      else res.errors.push(`${url}: ${(err as Error).message}`);
      return null;
    }
  };

  if (domain) {
    const candidates = [
      ...CAREERS_PATHS.map((p) => `https://${domain}${p}`),
      ...CAREERS_SUBDOMAINS.map((s) => `https://${s}.${domain}/`),
    ];
    const pages: { body: string; url: string }[] = [];
    for (const url of candidates) {
      const page = await visit(url);
      if (page) pages.push(page);
      // A redirect straight onto a board is conclusive; stop spending requests.
      if ([...found.values()].some((d) => d.confidence >= 1)) break;
    }
    if (!found.size && (opts.followLinks ?? 3) > 0) {
      const deeper = new Set<string>();
      for (const p of pages) for (const l of careerLinks(p.body, p.url, opts.followLinks ?? 3)) deeper.add(l);
      for (const url of [...deeper].slice(0, opts.followLinks ?? 3)) {
        if (res.visited.includes(url)) continue;
        await visit(url);
        if (found.size) break;
      }
    }
  }

  const name = input.name ?? (domain ? domain.split('.')[0] : undefined);
  if (!found.size && opts.probe !== false && name) {
    for (const d of await probeByName(deps, name, res)) add(d);
  }

  res.detections = [...found.values()].sort(rank);
  res.best = res.detections[0] ?? null;
  deps.log.debug({ domain, name, best: res.best, n: res.detections.length }, 'discover_ats');
  return res;
}

/**
 * Name-based API probes. A hit only proves *some* board with that slug exists,
 * so confidence stays low unless the board's own name matches the company.
 */
async function probeByName(deps: { pages: PageFetcher }, name: string, res: DiscoverAtsResult): Promise<AtsDetection[]> {
  const out: AtsDetection[] = [];
  const nameKey = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const getJson = async (url: string): Promise<unknown> => {
    try {
      const page = await deps.pages.get(url, { accept: 'application/json' });
      res.visited.push(url);
      if (page.status !== 200) return null;
      return JSON.parse(page.body) as unknown;
    } catch (err) {
      if (err instanceof RobotsDisallowedError) res.robotsBlocked.push(err.url);
      return null;
    }
  };
  for (const slug of slugCandidates(name)) {
    const gh = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}`)) as { name?: string } | null;
    if (gh && typeof gh === 'object' && 'name' in gh) {
      const match = (gh.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') === nameKey;
      out.push({ atsType: 'greenhouse', boardToken: slug, evidence: 'probe:greenhouse', confidence: match ? 0.75 : 0.5 });
    }
    const lv = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`);
    if (Array.isArray(lv)) out.push({ atsType: 'lever', boardToken: slug, evidence: 'probe:lever', confidence: lv.length ? 0.55 : 0.45 });
    const ab = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`)) as { jobs?: unknown[] } | null;
    if (ab && Array.isArray(ab.jobs)) {
      out.push({ atsType: 'ashby', boardToken: slug, evidence: 'probe:ashby', confidence: ab.jobs.length ? 0.55 : 0.45 });
    }
    // SmartRecruiters ids are case-sensitive and unknown ids return an empty 200.
    for (const id of new Set([slug, slug.charAt(0).toUpperCase() + slug.slice(1)])) {
      if (id.includes('-')) continue;
      const sr = (await getJson(`https://api.smartrecruiters.com/v1/companies/${id}/postings?limit=1`)) as { totalFound?: number } | null;
      if (sr && typeof sr.totalFound === 'number' && sr.totalFound > 0) {
        out.push({ atsType: 'smartrecruiters', boardToken: id, evidence: 'probe:smartrecruiters', confidence: 0.5 });
        break;
      }
    }
    if (out.length) break; // the most specific slug that hits wins
  }
  return out;
}

export interface DiscoverAndSaveResult extends DiscoverAtsResult {
  saved: SaveDiscoveredResult | null;
}

/**
 * Detect and persist: writes the company (deduped by domain, then name) and
 * every detection at or above `minConfidence` as a company_sources row, in
 * one transaction. Companies with no confident detection are still recorded
 * (coverage first) and picked up again by the periodic ATS re-check.
 */
export async function discoverAndSave(
  deps: { pages: PageFetcher; log: Logger; db: DB },
  input: DiscoverAtsInput & { name: string; tags?: string[]; location?: string | null; discoveredVia: string },
  opts: DiscoverAtsOptions & { minConfidence?: number; dryRun?: boolean } = {},
): Promise<DiscoverAndSaveResult> {
  const r = await discoverAts(deps, input, opts);
  if (opts.dryRun) return { ...r, saved: null };
  const min = opts.minConfidence ?? 0.5;
  const sources = r.detections.filter((d) => d.confidence >= min).map((d) => ({ atsType: d.atsType, boardToken: d.boardToken }));
  const saved = await saveDiscoveredCompany(deps.db, {
    name: input.name,
    domain: r.domain,
    tags: input.tags ?? [],
    location: input.location ?? null,
    discoveredVia: input.discoveredVia,
    sources,
  });
  return { ...r, saved };
}
