import { z } from 'zod';
import { PluginError } from '@jobforge/shared';
import {
  decodeEntities,
  defineSourcePlugin,
  HttpError,
  matchesLocationFilter,
  parseRelativePosted,
  remotePolicyFromText,
  detailApiUrl,
  jobsApiUrl,
  parseWorkdayToken,
  publicJobUrl,
  type PluginContext,
  type RawPosting,
  type WorkdayBoard,
} from '@jobforge/plugin-sdk';

export { detailApiUrl, formatWorkdayToken, jobsApiUrl, parseWorkdayToken, parseWorkdayUrl, publicJobUrl, type WorkdayBoard } from '@jobforge/plugin-sdk';

/** Workday's CXS API caps a page at 20 postings. */
export const PAGE_SIZE = 20;

const options = z.object({
  /** Free-text search sent to Workday (e.g. "software engineer intern"). Empty = everything. */
  searchText: z.string().default(''),
  /**
   * Case-insensitive substrings matched against the posting's locations
   * (e.g. ["India", "Bengaluru"]). Postings elsewhere are skipped before the
   * per-job detail request, which is what keeps big tenants affordable.
   */
  locations: z.array(z.string()).default([]),
  /** Stop after this many postings (list order). */
  maxPostings: z.number().int().positive().default(1000),
  /** Fetch each posting's detail (description, exact locations). Needed for matching. */
  fetchDetails: z.boolean().default(true),
});

export const configSchema = options;
export type WorkdayConfig = z.infer<typeof configSchema>;

/** Per-target overrides (company_sources.config); only the keys present win. */
const targetOptions = options.partial();

const listPosting = z
  .object({
    title: z.string(),
    externalPath: z.string(),
    locationsText: z.string().nullable().optional(),
    postedOn: z.string().nullable().optional(),
    bulletFields: z.array(z.string()).nullable().optional(),
    remoteType: z.string().nullable().optional(),
  })
  .passthrough();
const listResponse = z
  .object({
    total: z.number().nullable().optional(),
    jobPostings: z.array(listPosting).default([]),
  })
  .passthrough();

const detailResponse = z
  .object({
    jobPostingInfo: z
      .object({
        id: z.string().nullable().optional(),
        title: z.string(),
        jobDescription: z.string().nullable().optional(),
        location: z.string().nullable().optional(),
        additionalLocations: z.array(z.string()).nullable().optional(),
        postedOn: z.string().nullable().optional(),
        startDate: z.string().nullable().optional(),
        timeType: z.string().nullable().optional(),
        jobReqId: z.string().nullable().optional(),
        externalUrl: z.string().nullable().optional(),
        remoteType: z.string().nullable().optional(),
      })
      .passthrough(),
    hiringOrganization: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();

type ListPosting = z.infer<typeof listPosting>;
type Detail = z.infer<typeof detailResponse>;

/** "2 Locations" style summaries carry no place names; we need the detail to filter. */
const MULTI_LOCATION = /^\d+\s+locations?$/i;

export function toRawPosting(b: WorkdayBoard, item: ListPosting, detail: Detail | null, now = new Date()): RawPosting {
  const info = detail?.jobPostingInfo;
  const locations = detailLocations(detail) ?? listLocations(item);
  const url = validUrl(info?.externalUrl) ?? publicJobUrl(b, item.externalPath);
  const posted =
    (info?.startDate && !Number.isNaN(Date.parse(info.startDate)) ? new Date(info.startDate) : null) ??
    parseRelativePosted(info?.postedOn ?? item.postedOn, now);
  return {
    // jobReqId (e.g. R-1234567) is stable across reposts; fall back to the path.
    externalId: info?.jobReqId ?? item.bulletFields?.[0] ?? info?.id ?? item.externalPath,
    url,
    applyUrl: url,
    title: info?.title ?? item.title,
    locations,
    remotePolicy: remotePolicyFromText(info?.remoteType ?? item.remoteType ?? null),
    department: null,
    descriptionHtml: info?.jobDescription ? decodeEntities(info.jobDescription) : null,
    postedAt: posted,
    payload: { list: item, detail: info ?? null },
  };
}

function listLocations(item: ListPosting): string[] {
  const t = item.locationsText?.trim();
  return t && !MULTI_LOCATION.test(t) ? [t] : [];
}

function detailLocations(detail: Detail | null): string[] | null {
  const info = detail?.jobPostingInfo;
  if (!info) return null;
  const all = [info.location, ...(info.additionalLocations ?? [])].filter((l): l is string => !!l?.trim());
  return all.length ? [...new Set(all)] : null;
}

function validUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export function resolveOptions(base: WorkdayConfig, overrides: Record<string, unknown> | undefined): WorkdayConfig {
  if (!overrides) return base;
  const parsed = targetOptions.safeParse(overrides);
  if (!parsed.success) throw new PluginError(`invalid Workday target options: ${parsed.error.message}`);
  const o = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  return { ...base, ...o };
}

async function* fetchBoard(ctx: PluginContext<WorkdayConfig>, b: WorkdayBoard, opts: WorkdayConfig): AsyncGenerator<RawPosting> {
  let offset = 0;
  let total: number | null = null;
  let yielded = 0;
  let skipped = 0;
  for (;;) {
    const body = await ctx.http.getJson(jobsApiUrl(b), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: opts.searchText }),
    });
    const parsed = listResponse.safeParse(body);
    if (!parsed.success) {
      throw new PluginError(`unexpected Workday response for ${b.host}/${b.site}: ${parsed.error.message}`);
    }
    // Workday reports the real total on the first page only (later pages often say 0).
    if (total === null) total = parsed.data.total ?? null;
    const page = parsed.data.jobPostings;
    for (const item of page) {
      if (yielded >= opts.maxPostings) return;
      const listed = listLocations(item);
      if (listed.length && !matchesLocationFilter(listed, opts.locations)) {
        skipped++;
        continue;
      }
      let detail: Detail | null = null;
      if (opts.fetchDetails) {
        try {
          const d = detailResponse.safeParse(await ctx.http.getJson(detailApiUrl(b, item.externalPath)));
          if (d.success) detail = d.data;
          else ctx.log.warn({ path: item.externalPath }, 'unexpected Workday detail shape; using list fields');
        } catch (err) {
          // One broken posting must not sink the board; keep the list-level fields.
          if (!(err instanceof HttpError)) throw err;
          ctx.log.warn({ path: item.externalPath, err: err.message }, 'Workday detail fetch failed');
        }
      }
      const posting = toRawPosting(b, item, detail);
      if (!matchesLocationFilter(posting.locations, opts.locations)) {
        skipped++;
        continue;
      }
      yielded++;
      yield posting;
    }
    offset += page.length;
    if (!page.length || page.length < PAGE_SIZE || (total !== null && total > 0 && offset >= total)) break;
  }
  ctx.log.debug({ board: `${b.host}/${b.site}`, total, yielded, skipped }, 'workday board fetched');
}

export default defineSourcePlugin<WorkdayConfig>({
  manifest: {
    id: 'source-workday',
    version: '0.1.0',
    stage: 'source',
    description: 'Fetches postings from Workday tenants (*.myworkdayjobs.com / *.myworkdaysite.com CXS API).',
    configSchema,
    permissions: { domains: ['*.myworkdayjobs.com', '*.myworkdaysite.com'] },
    // Per host, and each tenant has its own host: effectively 1 req/s per tenant.
    rateLimit: { perDomain: { tokens: 1, intervalMs: 1000 } },
    sideEffects: 'none',
  },

  async *fetch(ctx, target) {
    let board: WorkdayBoard;
    try {
      board = parseWorkdayToken(target.boardToken);
    } catch (err) {
      // A malformed token can never succeed; surface it as a permanent failure.
      throw new HttpError((err as Error).message, target.boardToken, 400);
    }
    yield* fetchBoard(ctx, board, resolveOptions(ctx.config, target.options));
  },
});
