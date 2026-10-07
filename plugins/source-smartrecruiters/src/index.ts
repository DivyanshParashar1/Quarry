import { z } from 'zod';
import { PluginError } from '@jobforge/shared';
import {
  decodeEntities,
  defineSourcePlugin,
  HttpError,
  matchesLocationFilter,
  type RawPosting,
} from '@jobforge/plugin-sdk';

const HOST = 'api.smartrecruiters.com';
export const PAGE_SIZE = 100;

const options = z.object({
  /** Case-insensitive substrings matched against the posting location (e.g. ["India"]). */
  locations: z.array(z.string()).default([]),
  maxPostings: z.number().int().positive().default(1000),
  /** Fetch each posting's job ad (description). Needed for matching. */
  fetchDetails: z.boolean().default(true),
});
export const configSchema = options;
export type SmartRecruitersConfig = z.infer<typeof configSchema>;
const targetOptions = options.partial();

const location = z
  .object({
    city: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    remote: z.boolean().nullable().optional(),
    hybrid: z.boolean().nullable().optional(),
    fullLocation: z.string().nullable().optional(),
  })
  .passthrough();

const posting = z
  .object({
    id: z.string(),
    name: z.string(),
    refNumber: z.string().nullable().optional(),
    releasedDate: z.string().nullable().optional(),
    location: location.nullable().optional(),
    department: z.object({ label: z.string().nullable().optional() }).passthrough().nullable().optional(),
    postingUrl: z.string().nullable().optional(),
    applyUrl: z.string().nullable().optional(),
    jobAd: z
      .object({
        sections: z
          .record(z.object({ title: z.string().nullable().optional(), text: z.string().nullable().optional() }).passthrough())
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
const listResponse = z.object({
  offset: z.number().optional(),
  totalFound: z.number(),
  content: z.array(posting),
});
type Posting = z.infer<typeof posting>;

export function listUrl(companyId: string, offset: number): string {
  return `https://${HOST}/v1/companies/${encodeURIComponent(companyId)}/postings?limit=${PAGE_SIZE}&offset=${offset}`;
}
export function detailUrl(companyId: string, postingId: string): string {
  return `https://${HOST}/v1/companies/${encodeURIComponent(companyId)}/postings/${encodeURIComponent(postingId)}`;
}

const SECTION_ORDER = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription'];

function locationText(p: Posting): string[] {
  const l = p.location;
  if (!l) return [];
  if (l.fullLocation?.trim()) return [l.fullLocation.trim()];
  const parts = [l.city, l.region, l.country?.toUpperCase()].filter((x): x is string => !!x?.trim());
  return parts.length ? [parts.join(', ')] : [];
}

export function toRawPosting(companyId: string, p: Posting): RawPosting {
  const sections = p.jobAd?.sections ?? {};
  const html = SECTION_ORDER.filter((k) => sections[k]?.text)
    .map((k) => `<h3>${sections[k]!.title ?? k}</h3>${sections[k]!.text}`)
    .join('\n');
  const url = p.postingUrl ?? `https://jobs.smartrecruiters.com/${encodeURIComponent(companyId)}/${p.id}`;
  return {
    externalId: p.id,
    url,
    applyUrl: p.applyUrl ?? url,
    title: p.name,
    locations: locationText(p),
    remotePolicy: p.location?.remote ? 'remote' : p.location?.hybrid ? 'hybrid' : null,
    department: p.department?.label ?? null,
    descriptionHtml: html ? decodeEntities(html) : null,
    postedAt: p.releasedDate && !Number.isNaN(Date.parse(p.releasedDate)) ? new Date(p.releasedDate) : null,
    payload: p,
  };
}

export default defineSourcePlugin<SmartRecruitersConfig>({
  manifest: {
    id: 'source-smartrecruiters',
    version: '0.1.0',
    stage: 'source',
    description: 'Fetches postings from the SmartRecruiters public Posting API (api.smartrecruiters.com).',
    configSchema,
    permissions: { domains: [HOST] },
    rateLimit: { perDomain: { tokens: 2, intervalMs: 1000 } },
    sideEffects: 'none',
  },

  async *fetch(ctx, target) {
    const parsedOpts = targetOptions.safeParse(target.options ?? {});
    if (!parsedOpts.success) throw new PluginError(`invalid SmartRecruiters target options: ${parsedOpts.error.message}`);
    const opts = { ...ctx.config, ...Object.fromEntries(Object.entries(parsedOpts.data).filter(([, v]) => v !== undefined)) };
    const companyId = target.boardToken;
    let offset = 0;
    let yielded = 0;
    for (;;) {
      const body = await ctx.http.getJson(listUrl(companyId, offset));
      const parsed = listResponse.safeParse(body);
      if (!parsed.success) {
        throw new PluginError(`unexpected SmartRecruiters response for ${companyId}: ${parsed.error.message}`);
      }
      const { content, totalFound } = parsed.data;
      if (offset === 0 && totalFound === 0) {
        // SmartRecruiters answers 200/empty for unknown company ids, so this is
        // either a quiet board or a wrong id; worth a look either way.
        ctx.log.info({ companyId }, 'smartrecruiters company has no postings (or the id is wrong)');
      }
      for (const item of content) {
        if (yielded >= opts.maxPostings) return;
        if (!matchesLocationFilter(locationText(item), opts.locations)) continue;
        let full: Posting = item;
        if (opts.fetchDetails) {
          try {
            const d = posting.safeParse(await ctx.http.getJson(detailUrl(companyId, item.id)));
            if (d.success) full = { ...item, ...d.data };
          } catch (err) {
            if (!(err instanceof HttpError)) throw err;
            ctx.log.warn({ id: item.id, err: err.message }, 'SmartRecruiters detail fetch failed');
          }
        }
        yielded++;
        yield toRawPosting(companyId, full);
      }
      offset += content.length;
      if (!content.length || offset >= totalFound) break;
    }
  },
});
