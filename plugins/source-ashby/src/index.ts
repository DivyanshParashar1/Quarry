import { z } from 'zod';
import { PluginError } from '@jobforge/shared';
import { defineSourcePlugin, type RawPosting, type RemotePolicy } from '@jobforge/plugin-sdk';

export const configSchema = z.object({
  /** Include compensation in the payload (kept for later stages; not normalized yet). */
  includeCompensation: z.boolean().default(true),
});
export type AshbyConfig = z.infer<typeof configSchema>;

const HOST = 'api.ashbyhq.com';

// Lenient on purpose: only id/title are required, everything else may be
// missing or null. The untouched object is kept in `payload`.
const ashbyJob = z
  .object({
    id: z.string(),
    title: z.string(),
    location: z.string().nullable().optional(),
    secondaryLocations: z
      .array(z.object({ location: z.string().nullable().optional() }).passthrough())
      .nullable()
      .optional(),
    department: z.string().nullable().optional(),
    team: z.string().nullable().optional(),
    isListed: z.boolean().nullable().optional(),
    isRemote: z.boolean().nullable().optional(),
    workplaceType: z.string().nullable().optional(),
    descriptionHtml: z.string().nullable().optional(),
    descriptionPlain: z.string().nullable().optional(),
    publishedAt: z.string().nullable().optional(),
    jobUrl: z.string().url().nullable().optional(),
    applyUrl: z.string().url().nullable().optional(),
  })
  .passthrough();
const ashbyResponse = z.object({ jobs: z.array(ashbyJob) }).passthrough();
type AshbyJob = z.infer<typeof ashbyJob>;

export function boardUrl(board: string, includeCompensation = true): string {
  return `https://${HOST}/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=${includeCompensation}`;
}

const WORKPLACE: Record<string, RemotePolicy> = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite' };

export function toRawPosting(j: AshbyJob): RawPosting {
  const locations = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(
    (l): l is string => !!l && !!l.trim(),
  );
  const wp = (j.workplaceType ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const published = j.publishedAt ? new Date(j.publishedAt) : null;
  return {
    externalId: j.id,
    url: j.jobUrl ?? null,
    applyUrl: j.applyUrl ?? j.jobUrl ?? null,
    title: j.title,
    locations,
    remotePolicy: WORKPLACE[wp] ?? (j.isRemote ? 'remote' : null),
    department: j.department ?? j.team ?? null,
    descriptionHtml: j.descriptionHtml ?? (j.descriptionPlain ? escapeHtml(j.descriptionPlain) : null),
    postedAt: published && !Number.isNaN(published.getTime()) ? published : null,
    payload: j,
  };
}

export default defineSourcePlugin<AshbyConfig>({
  manifest: {
    id: 'source-ashby',
    version: '0.1.0',
    stage: 'source',
    description: 'Fetches postings from an Ashby public job board (api.ashbyhq.com posting API).',
    configSchema,
    permissions: { domains: [HOST] },
    rateLimit: { perDomain: { tokens: 2, intervalMs: 1000 } },
    sideEffects: 'none',
  },

  async *fetch(ctx, target) {
    const body = await ctx.http.getJson(boardUrl(target.boardToken, ctx.config.includeCompensation));
    const parsed = ashbyResponse.safeParse(body);
    if (!parsed.success) {
      throw new PluginError(`unexpected Ashby response for ${target.boardToken}: ${parsed.error.message}`);
    }
    ctx.log.debug({ board: target.boardToken, count: parsed.data.jobs.length }, 'ashby postings fetched');
    for (const j of parsed.data.jobs) {
      if (j.isListed === false) continue; // unlisted postings are not public openings
      yield toRawPosting(j);
    }
  },
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}
