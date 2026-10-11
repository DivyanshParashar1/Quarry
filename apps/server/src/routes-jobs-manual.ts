import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appendEvent, recordPosting, upsertCompany, type DB } from '@jobforge/db';
import { emitStage, normalizePosting } from '@jobforge/core';

// Add a job by hand (a link the user found; the chatbot fetches the JD and posts
// it here). It becomes a canonical job like any fetched posting — deduped by
// fingerprint — and goes through matching, tailoring and referrals as usual.

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Plain text / markdown → simple paragraphs (the normaliser turns HTML into markdown). */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/^[-*•]\s/m.test(p) ? `<ul>${p.split('\n').map((l) => `<li>${escapeHtml(l.replace(/^[-*•]\s*/, ''))}</li>`).join('')}</ul>` : `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`))
    .join('\n');
}

export const manualJobSchema = z
  .object({
    company: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(300),
    url: z.string().url().refine((u) => u.startsWith('https://') || u.startsWith('http://'), 'http(s) only'),
    /** Where it was applied for, if different from the posting page. */
    applyUrl: z.string().url().optional(),
    locations: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    remotePolicy: z.enum(['remote', 'hybrid', 'onsite']).nullable().default(null),
    /** The job description as plain text / markdown (preferred) or HTML. */
    description: z.string().max(60_000).optional(),
    descriptionHtml: z.string().max(200_000).optional(),
    department: z.string().max(200).nullable().default(null),
    postedAt: z.coerce.date().nullable().default(null),
  })
  .strict();

export function registerManualJobRoutes(app: FastifyInstance, o: { db: DB }): void {
  app.post('/api/jobs', async (req, reply) => {
    const b = manualJobSchema.parse(req.body ?? {});
    const company = await upsertCompany(o.db, { name: b.company });
    const raw = {
      externalId: b.url,
      url: b.url,
      applyUrl: b.applyUrl ?? b.url,
      title: b.title,
      locations: b.locations,
      remotePolicy: b.remotePolicy,
      department: b.department,
      descriptionHtml: b.descriptionHtml ?? (b.description ? textToHtml(b.description) : null),
      postedAt: b.postedAt,
      payload: { source: 'manual' },
    };
    const r = await recordPosting(o.db, { ...normalizePosting(raw, b.company), companyId: company.id }, { sourcePlugin: 'manual', companySourceId: null, externalId: b.url, url: b.url, payload: raw.payload }, new Date());
    await appendEvent(o.db, { kind: 'job.added_manually', subjectType: 'job', subjectId: r.jobId, payload: { url: b.url, created: r.jobCreated } });
    if (r.jobCreated) emitStage({ kind: 'jobs.new', jobIds: [r.jobId] });
    return reply.status(r.jobCreated ? 201 : 200).send({ jobId: r.jobId, created: r.jobCreated, companyId: company.id });
  });
}
