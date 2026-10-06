import { z } from 'zod';
import { PluginError } from '@jobforge/shared';
import { decodeEntities, defineSourcePlugin, type RawPosting, type RemotePolicy } from '@jobforge/plugin-sdk';

export const configSchema = z.object({
  /** Fetch full descriptions (`content=true`). Larger payloads, but needed for matching. */
  includeContent: z.boolean().default(true),
});
export type GreenhouseConfig = z.infer<typeof configSchema>;

const HOST = 'boards-api.greenhouse.io';

// Only the fields we read are validated; everything else passes through into `payload`.
const ghJob = z
  .object({
    id: z.number(),
    title: z.string(),
    absolute_url: z.string().url().nullable().optional(),
    location: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
    content: z.string().nullable().optional(),
    first_published: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    departments: z.array(z.object({ name: z.string() })).optional(),
    metadata: z
      .array(z.object({ name: z.string().nullable().optional(), value: z.unknown() }))
      .nullable()
      .optional(),
  })
  .passthrough();
const ghResponse = z.object({ jobs: z.array(ghJob) });
type GhJob = z.infer<typeof ghJob>;

export function boardUrl(token: string, includeContent: boolean): string {
  return `https://${HOST}/v1/boards/${encodeURIComponent(token)}/jobs${includeContent ? '?content=true' : ''}`;
}

export function toRawPosting(job: GhJob): RawPosting {
  const url = job.absolute_url ?? null;
  const posted = job.first_published ?? job.updated_at;
  return {
    externalId: String(job.id),
    url,
    applyUrl: url,
    title: job.title,
    locations: (job.location?.name ?? '').split(/\s*[;|]\s*/).filter((s) => s.trim()),
    remotePolicy: workplaceType(job),
    department: job.departments?.[0]?.name ?? null,
    // Greenhouse returns entity-escaped HTML.
    descriptionHtml: job.content ? decodeEntities(job.content) : null,
    postedAt: posted ? new Date(posted) : null,
    payload: job,
  };
}

function workplaceType(job: GhJob): RemotePolicy | null {
  const field = job.metadata?.find((m) => m.name && /workplace type|remote/i.test(m.name));
  const v = typeof field?.value === 'string' ? field.value.toLowerCase() : '';
  if (v.includes('remote')) return 'remote';
  if (v.includes('hybrid')) return 'hybrid';
  if (v.includes('on-site') || v.includes('onsite') || v.includes('in office') || v.includes('in-office'))
    return 'onsite';
  return null;
}

export default defineSourcePlugin<GreenhouseConfig>({
  manifest: {
    id: 'source-greenhouse',
    version: '0.1.0',
    stage: 'source',
    description: 'Fetches postings from a Greenhouse public job board (boards-api.greenhouse.io).',
    configSchema,
    permissions: { domains: [HOST] },
    rateLimit: { perDomain: { tokens: 2, intervalMs: 1000 } },
    sideEffects: 'none',
  },

  async *fetch(ctx, target) {
    const body = await ctx.http.getJson(boardUrl(target.boardToken, ctx.config.includeContent));
    const parsed = ghResponse.safeParse(body);
    if (!parsed.success) {
      throw new PluginError(`unexpected Greenhouse response for ${target.boardToken}: ${parsed.error.message}`);
    }
    ctx.log.debug({ board: target.boardToken, count: parsed.data.jobs.length }, 'greenhouse board fetched');
    for (const job of parsed.data.jobs) yield toRawPosting(job);
  },
});
