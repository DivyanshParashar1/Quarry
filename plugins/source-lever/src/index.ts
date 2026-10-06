import { z } from 'zod';
import { PluginError } from '@jobforge/shared';
import { defineSourcePlugin, type RawPosting, type RemotePolicy } from '@jobforge/plugin-sdk';

export const configSchema = z.object({});
export type LeverConfig = z.infer<typeof configSchema>;

const HOST = 'api.lever.co';

const leverPosting = z
  .object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.string().url().nullable().optional(),
    applyUrl: z.string().url().nullable().optional(),
    createdAt: z.number().nullable().optional(),
    workplaceType: z.string().nullable().optional(),
    categories: z
      .object({
        location: z.string().nullable().optional(),
        allLocations: z.array(z.string()).nullable().optional(),
        department: z.string().nullable().optional(),
        team: z.string().nullable().optional(),
      })
      .partial()
      .nullable()
      .optional(),
    description: z.string().nullable().optional(),
    lists: z
      .array(z.object({ text: z.string().nullable().optional(), content: z.string().nullable().optional() }))
      .nullable()
      .optional(),
    additional: z.string().nullable().optional(),
  })
  .passthrough();
const leverResponse = z.array(leverPosting);
type LeverPosting = z.infer<typeof leverPosting>;

export function postingsUrl(company: string): string {
  return `https://${HOST}/v0/postings/${encodeURIComponent(company)}?mode=json`;
}

const WORKPLACE: Record<string, RemotePolicy> = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite' };

export function toRawPosting(p: LeverPosting): RawPosting {
  const cat = p.categories ?? {};
  const locations = cat.allLocations?.length ? cat.allLocations : cat.location ? [cat.location] : [];
  // Lever splits the description into an intro, titled lists ("Requirements", ...), and a closing block.
  const parts = [p.description ?? ''];
  for (const l of p.lists ?? []) {
    if (l.text) parts.push(`<h3>${l.text}</h3>`);
    if (l.content) parts.push(`<ul>${l.content}</ul>`);
  }
  if (p.additional) parts.push(p.additional);
  const descriptionHtml = parts.join('\n').trim();
  return {
    externalId: p.id,
    url: p.hostedUrl ?? null,
    applyUrl: p.applyUrl ?? p.hostedUrl ?? null,
    title: p.text,
    locations,
    remotePolicy: WORKPLACE[p.workplaceType ?? ''] ?? null,
    department: cat.department ?? cat.team ?? null,
    descriptionHtml: descriptionHtml || null,
    postedAt: typeof p.createdAt === 'number' ? new Date(p.createdAt) : null,
    payload: p,
  };
}

export default defineSourcePlugin<LeverConfig>({
  manifest: {
    id: 'source-lever',
    version: '0.1.0',
    stage: 'source',
    description: 'Fetches postings from a Lever public postings API (api.lever.co).',
    configSchema,
    permissions: { domains: [HOST] },
    // api.lever.co/robots.txt asks for Crawl-delay: 1
    rateLimit: { perDomain: { tokens: 1, intervalMs: 1000 } },
    sideEffects: 'none',
  },

  async *fetch(ctx, target) {
    const body = await ctx.http.getJson(postingsUrl(target.boardToken));
    const parsed = leverResponse.safeParse(body);
    if (!parsed.success) {
      throw new PluginError(`unexpected Lever response for ${target.boardToken}: ${parsed.error.message}`);
    }
    ctx.log.debug({ company: target.boardToken, count: parsed.data.length }, 'lever postings fetched');
    for (const p of parsed.data) yield toRawPosting(p);
  },
});
