import { z } from 'zod';
import { PluginError } from '@jobforge/shared';
import {
  decodeEntities,
  defineSourcePlugin,
  HttpError,
  matchesLocationFilter,
  parseSuccessFactorsToken,
  remotePolicyFromText,
  sanitizeHtml,
  xmlChild,
  xmlElements,
  type PluginContext,
  type RawPosting,
  type SuccessFactorsBoard,
} from '@jobforge/plugin-sdk';

const options = z.object({
  /** Case-insensitive substrings matched against locations (e.g. ["India", "IN"]). */
  locations: z.array(z.string()).default([]),
  maxPostings: z.number().int().positive().default(1000),
  /** RMK sites: fetch each job page for its description. */
  fetchDetails: z.boolean().default(true),
});
export const configSchema = options;
export type SuccessFactorsConfig = z.infer<typeof configSchema>;
const targetOptions = options.partial();

/** RMK search pages show 25 rows. */
export const RMK_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// classic: XML job-listing feed
// ---------------------------------------------------------------------------

export function classicFeedUrl(b: Extract<SuccessFactorsBoard, { kind: 'classic' }>): string {
  return `https://${b.host}/career?company=${encodeURIComponent(b.companyId)}&career_ns=job_listing_summary&resultType=XML`;
}

export function classicJobUrl(b: Extract<SuccessFactorsBoard, { kind: 'classic' }>, reqId: string): string {
  return `https://${b.host}/career?company=${encodeURIComponent(b.companyId)}&career_ns=job_listing&career_job_req_id=${encodeURIComponent(reqId)}&navBarLevel=JOB_SEARCH`;
}

export function parseClassicFeed(xml: string, b: Extract<SuccessFactorsBoard, { kind: 'classic' }>): RawPosting[] {
  if (!/<Job[\s>]/i.test(xml) && !/<Job-Listing/i.test(xml)) {
    throw new PluginError(`unexpected SuccessFactors feed for ${b.companyId} (no <Job> elements)`);
  }
  const out: RawPosting[] = [];
  for (const job of xmlElements(xml, 'Job')) {
    const id = xmlChild(job, ['ReqId', 'Req-Id', 'JobReqId', 'Job-Req-Id', 'id']);
    const title = xmlChild(job, ['JobTitle', 'Job-Title', 'Title']);
    if (!id || !title) continue;
    const city = xmlChild(job, ['City']);
    const country = xmlChild(job, ['Country']);
    const loc = xmlChild(job, ['Location', 'Job-Location']) ?? ([city, country].filter(Boolean).join(', ') || null);
    const desc = xmlChild(job, ['Job-Description', 'JobDescription', 'ExternalJobDescription', 'Description']);
    const posted = xmlChild(job, ['Posted-Date', 'PostedDate', 'Posting-Date', 'Date']);
    const url = xmlChild(job, ['Job-Url', 'JobUrl', 'Url', 'ApplyUrl']) ?? classicJobUrl(b, id);
    out.push({
      externalId: id,
      url: /^https:\/\//.test(url) ? url : classicJobUrl(b, id),
      applyUrl: /^https:\/\//.test(url) ? url : classicJobUrl(b, id),
      title: decodeEntities(title),
      locations: loc ? [loc] : [],
      remotePolicy: remotePolicyFromText(loc),
      department: xmlChild(job, ['Department', 'Function']),
      descriptionHtml: desc ? sanitizeHtml(decodeEntities(desc)) : null,
      postedAt: posted && !Number.isNaN(Date.parse(posted)) ? new Date(posted) : null,
      payload: { feed: 'classic', reqId: id, location: loc },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RMK: HTML search pages + job pages
// ---------------------------------------------------------------------------

export function rmkSearchUrl(host: string, startrow: number): string {
  return `https://${host}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=${startrow}`;
}

export interface RmkRow {
  id: string;
  path: string;
  title: string;
  location: string | null;
  date: string | null;
}

/** Rows of an RMK search page plus the "of N" total. */
export function parseRmkSearch(html: string): { rows: RmkRow[]; total: number | null } {
  const rows: RmkRow[] = [];
  const seen = new Set<string>();
  // Each row: <tr class="data-row"> … <a class="jobTitle-link" href="/job/City-Title/123456789/">Title</a> … jobLocation … jobDate
  for (const tr of html.split(/<tr\b[^>]*class="[^"]*data-row/i).slice(1)) {
    const a = tr.match(/<a\b[^>]*href="(\/job\/[^"]*?\/(\d{5,})\/?)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a || seen.has(a[2]!)) continue;
    seen.add(a[2]!);
    const loc = tr.match(/class="[^"]*jobLocation[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1];
    const date = tr.match(/class="[^"]*jobDate[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1];
    rows.push({
      id: a[2]!,
      path: a[1]!,
      title: decodeEntities(a[3]!.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
      location: loc ? decodeEntities(loc.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() || null : null,
      date: date ? decodeEntities(date.replace(/<[^>]+>/g, '')).trim() || null : null,
    });
  }
  const total = html.match(/paginationLabel[\s\S]{0,200}?of\s*(?:<b>)?\s*([\d,]+)/i)?.[1];
  return { rows, total: total ? Number(total.replace(/,/g, '')) : null };
}

/** The description block of an RMK job page (itemprop or jobdescription span). */
export function parseRmkJobPage(html: string): string | null {
  const m =
    html.match(/<span[^>]*class="[^"]*jobdescription[^"]*"[^>]*>([\s\S]*?)<\/span>\s*(?:<\/div>|<div[^>]*class="[^"]*job(?:Footer|Apply))/i) ??
    html.match(/<[^>]+itemprop="description"[^>]*>([\s\S]*?)<\/(?:div|span)>\s*<\/div>/i);
  return m?.[1] ? sanitizeHtml(m[1]) || null : null;
}

async function* fetchRmk(ctx: PluginContext<SuccessFactorsConfig>, host: string, opts: SuccessFactorsConfig): AsyncGenerator<RawPosting> {
  let start = 0;
  let total: number | null = null;
  let yielded = 0;
  for (;;) {
    const page = parseRmkSearch(await ctx.http.getText(rmkSearchUrl(host, start)));
    if (start === 0 && !page.rows.length && page.total === null) {
      throw new PluginError(`no job rows on ${host} (not an RMK site, or the layout changed)`);
    }
    total ??= page.total;
    for (const r of page.rows) {
      if (yielded >= opts.maxPostings) return;
      if (!matchesLocationFilter(r.location ? [r.location] : [], opts.locations)) continue;
      const url = `https://${host}${r.path}`;
      let desc: string | null = null;
      if (opts.fetchDetails) {
        try {
          desc = parseRmkJobPage(await ctx.http.getText(url));
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          ctx.log.warn({ url, err: err.message }, 'SuccessFactors job page failed');
        }
      }
      yielded++;
      yield {
        externalId: r.id,
        url,
        applyUrl: url,
        title: r.title,
        locations: r.location ? [r.location] : [],
        remotePolicy: remotePolicyFromText(r.location),
        department: null,
        descriptionHtml: desc,
        postedAt: r.date && !Number.isNaN(Date.parse(r.date)) ? new Date(r.date) : null,
        payload: { feed: 'rmk', ...r },
      };
    }
    start += page.rows.length;
    if (!page.rows.length || page.rows.length < RMK_PAGE_SIZE || (total !== null && start >= total)) break;
  }
}

export default defineSourcePlugin<SuccessFactorsConfig>({
  manifest: {
    id: 'source-successfactors',
    version: '0.1.0',
    stage: 'source',
    description: 'Fetches postings from SAP SuccessFactors career sites (classic XML feed, or RMK sites on SAP hosts).',
    configSchema,
    permissions: { domains: ['*.successfactors.com', '*.successfactors.eu', '*.sapsf.com', '*.sapsf.eu'] },
    rateLimit: { perDomain: { tokens: 1, intervalMs: 1000 } },
    sideEffects: 'none',
  },

  async *fetch(ctx, target) {
    let board: SuccessFactorsBoard;
    try {
      board = parseSuccessFactorsToken(target.boardToken);
    } catch (err) {
      throw new HttpError((err as Error).message, target.boardToken, 400);
    }
    const o = targetOptions.safeParse(target.options ?? {});
    if (!o.success) throw new PluginError(`invalid SuccessFactors target options: ${o.error.message}`);
    const opts = { ...ctx.config, ...Object.fromEntries(Object.entries(o.data).filter(([, v]) => v !== undefined)) };

    if (board.kind === 'rmk') {
      yield* fetchRmk(ctx, board.host, opts);
      return;
    }
    const xml = await ctx.http.getText(classicFeedUrl(board), { headers: { accept: 'application/xml,text/xml' } });
    let n = 0;
    for (const p of parseClassicFeed(xml, board)) {
      if (n >= opts.maxPostings) break;
      if (!matchesLocationFilter(p.locations, opts.locations)) continue;
      n++;
      yield p;
    }
  },
});
