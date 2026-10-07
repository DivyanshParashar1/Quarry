import { z } from 'zod';
import { PluginError } from '@jobforge/shared';
import {
  decodeEntities,
  defineSourcePlugin,
  HttpError,
  matchesLocationFilter,
  parseTaleoToken,
  remotePolicyFromText,
  type RawPosting,
  type TaleoBoard,
} from '@jobforge/plugin-sdk';

const options = z.object({
  locations: z.array(z.string()).default([]),
  maxPostings: z.number().int().positive().default(1000),
  /** Taleo's portal id; discovered from the career section page when absent. */
  portal: z.string().regex(/^\d+$/).optional(),
  /** Max result pages (25 rows each). */
  maxPages: z.number().int().positive().default(40),
});
export const configSchema = options;
export type TaleoConfig = z.infer<typeof configSchema>;
const targetOptions = options.partial();

export function searchPageUrl(b: TaleoBoard): string {
  return `https://${b.host}/careersection/${encodeURIComponent(b.section)}/jobsearch.ftl?lang=en`;
}
export function searchApiUrl(b: TaleoBoard, portal: string): string {
  return `https://${b.host}/careersection/rest/jobboard/searchjobs?lang=en&portal=${portal}`;
}
export function jobUrl(b: TaleoBoard, contestNo: string): string {
  return `https://${b.host}/careersection/${encodeURIComponent(b.section)}/jobdetail.ftl?job=${encodeURIComponent(contestNo)}&lang=en`;
}

/** The portal id Taleo's search page embeds in its JS/config (`portal=8105120395`). */
export function findPortalId(html: string): string | null {
  return (
    html.match(/[?&;]portal=(\d{6,})/)?.[1] ??
    html.match(/["']?portal(?:Id)?["']?\s*[:=]\s*["']?(\d{6,})/i)?.[1] ??
    null
  );
}

export function searchBody(pageNo: number): string {
  return JSON.stringify({
    multilineEnabled: false,
    sortingSelection: { sortBySelectionParam: '3', ascendingSortingOrder: 'false' },
    fieldData: { fields: { KEYWORD: '', LOCATION: '' }, valid: true },
    filterSelectionParam: { searchFilterSelections: [] },
    advancedSearchFiltersSelectionParam: { searchFilterSelections: [] },
    pageNo,
  });
}

const requisition = z
  .object({
    jobId: z.union([z.string(), z.number()]).transform(String),
    contestNo: z.string().nullable().optional(),
    column: z.array(z.string().nullable()).default([]),
  })
  .passthrough();
const searchResponse = z
  .object({
    requisitionList: z.array(requisition).default([]),
    pagingData: z.object({ totalCount: z.number().optional(), pageSize: z.number().optional(), currentPageNo: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();
type Requisition = z.infer<typeof requisition>;

/** Columns are [title, locations, date] on most sections; locations are a JSON-ish list ("[\"Mumbai\",\"Pune\"]"). */
export function toRawPosting(b: TaleoBoard, r: Requisition): RawPosting | null {
  const [title, rawLoc, date] = r.column;
  if (!title) return null;
  let locations: string[] = [];
  if (rawLoc) {
    try {
      const parsed = JSON.parse(rawLoc) as unknown;
      locations = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [String(parsed)];
    } catch {
      locations = rawLoc.split(/\s*[;|]\s*/).filter(Boolean);
    }
  }
  locations = locations.map((l) => decodeEntities(l).replace(/\s*-\s*/g, ', ').trim()).filter(Boolean);
  const contest = r.contestNo ?? r.jobId;
  const url = jobUrl(b, contest);
  return {
    externalId: r.jobId,
    url,
    applyUrl: url,
    title: decodeEntities(title).trim(),
    locations,
    remotePolicy: remotePolicyFromText(locations.join(' ')),
    department: null,
    // Taleo renders descriptions client-side; the matcher works from the title until a detail parser lands.
    descriptionHtml: null,
    postedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date) : null,
    payload: r,
  };
}

export default defineSourcePlugin<TaleoConfig>({
  manifest: {
    id: 'source-taleo',
    version: '0.1.0',
    stage: 'source',
    description: 'Best-effort fetch of Oracle Taleo career sections (*.taleo.net) via the job board search endpoint.',
    configSchema,
    permissions: { domains: ['*.taleo.net'] },
    rateLimit: { perDomain: { tokens: 1, intervalMs: 1000 } },
    sideEffects: 'none',
  },

  async *fetch(ctx, target) {
    let board: TaleoBoard;
    try {
      board = parseTaleoToken(target.boardToken);
    } catch (err) {
      throw new HttpError((err as Error).message, target.boardToken, 400);
    }
    const o = targetOptions.safeParse(target.options ?? {});
    if (!o.success) throw new PluginError(`invalid Taleo target options: ${o.error.message}`);
    const opts = { ...ctx.config, ...Object.fromEntries(Object.entries(o.data).filter(([, v]) => v !== undefined)) };

    const portal = opts.portal ?? findPortalId(await ctx.http.getText(searchPageUrl(board)));
    if (!portal) {
      throw new PluginError(`could not find the Taleo portal id on ${searchPageUrl(board)}; set company_sources.config.portal`);
    }
    let yielded = 0;
    let seen = 0;
    for (let page = 1; page <= opts.maxPages; page++) {
      const body = await ctx.http.getJson(searchApiUrl(board, portal), {
        method: 'POST',
        headers: { 'content-type': 'application/json', tz: 'GMT+05:30' },
        body: searchBody(page),
      });
      const parsed = searchResponse.safeParse(body);
      if (!parsed.success) throw new PluginError(`unexpected Taleo response for ${board.tenant}/${board.section}: ${parsed.error.message}`);
      const list = parsed.data.requisitionList;
      for (const r of list) {
        if (yielded >= opts.maxPostings) return;
        const p = toRawPosting(board, r);
        if (!p || !matchesLocationFilter(p.locations, opts.locations)) continue;
        yielded++;
        yield p;
      }
      seen += list.length;
      const total = parsed.data.pagingData?.totalCount;
      if (!list.length || (total !== undefined && seen >= total)) break;
    }
  },
});
