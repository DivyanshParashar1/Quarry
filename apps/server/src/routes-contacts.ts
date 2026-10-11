import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getJobDetail, latestRenderedResumeForJob, listContactImports, type DB } from '@jobforge/db';
import {
  commitContactImport,
  ContactImportError,
  discardContactImport,
  getImportPreview,
  listLinkedInDrafts,
  llmColumnClassifier,
  markLinkedInReplied,
  markLinkedInSent,
  previewContactImport,
  UnsupportedFileError,
  type OutreachPolicy,
} from '@jobforge/core';
import type { LLMClient } from '@jobforge/shared';

// Phase 17: contact-sheet import (upload → preview → commit) and the manual
// LinkedIn queue (drafts the user copies, then marks sent / replied).

export interface ContactRouteOptions {
  db: DB;
  policy: OutreachPolicy;
  /** For classifying columns the heuristics can't place; optional. */
  llm?: () => Promise<LLMClient>;
}

const idParams = z.object({ id: z.string().uuid() });
const MAX_UPLOAD = 10 * 1024 * 1024;

export function registerContactRoutes(app: FastifyInstance, o: ContactRouteOptions): void {
  const { db } = o;

  app.post('/api/contacts/import', async (req, reply) => {
    const file = await (req as unknown as { file: () => Promise<{ toBuffer: () => Promise<Buffer>; filename: string } | undefined> }).file();
    if (!file) return reply.status(400).send({ error: 'no_file' });
    const buf = await file.toBuffer();
    if (buf.length > MAX_UPLOAD) return reply.status(413).send({ error: 'too_large', message: 'max 10MB' });
    const llm = o.llm ? await o.llm().catch(() => null) : null;
    try {
      const preview = await previewContactImport(db, { data: buf, filename: file.filename }, llm ? { classify: llmColumnClassifier(llm) } : {});
      return reply.status(201).send(preview);
    } catch (err) {
      if (err instanceof UnsupportedFileError) return reply.status(415).send({ error: 'unsupported', message: err.message });
      return reply.status(422).send({ error: 'unreadable', message: (err as Error).message });
    }
  });

  app.get('/api/contacts/imports', async () => ({ imports: await listContactImports(db) }));

  app.get('/api/contacts/imports/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return (await getImportPreview(db, id)) ?? reply.status(404).send({ error: 'not_found' });
  });

  app.post('/api/contacts/imports/:id/commit', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    try {
      return await commitContactImport(db, id);
    } catch (err) {
      if (err instanceof ContactImportError) return reply.status(409).send({ error: 'invalid_state', message: err.message });
      throw err;
    }
  });

  app.post('/api/contacts/imports/:id/discard', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    return (await discardContactImport(db, id)) ? { ok: true } : reply.status(409).send({ error: 'invalid_state', message: 'not a pending preview' });
  });

  // --- manual LinkedIn ---------------------------------------------------------
  app.get('/api/linkedin/drafts', async (req) => {
    const q = z.object({ jobId: z.string().uuid().optional(), sent: z.coerce.boolean().default(false) }).parse(req.query);
    const drafts = await listLinkedInDrafts(db, { ...(q.jobId ? { jobId: q.jobId } : {}), includeSent: q.sent });
    const jobs = new Map<string, { title: string; company: string; resumePdf: string | null }>();
    for (const jobId of new Set(drafts.map((d) => d.jobId).filter((x): x is string => !!x))) {
      const job = await getJobDetail(db, jobId, null);
      const resume = await latestRenderedResumeForJob(db, jobId);
      jobs.set(jobId, {
        title: job?.title ?? '',
        company: job?.company.name ?? '',
        resumePdf: resume?.pdfPath ? `/api/resume-variants/${resume.id}/pdf` : null,
      });
    }
    return {
      drafts: drafts.map((d) => ({
        id: d.id,
        status: d.status,
        jobId: d.jobId,
        contactId: d.contactId,
        contactName: d.contactName,
        companyName: d.companyName,
        createdAt: d.createdAt,
        linkedin: d.linkedin,
        // The resume the message says is attached: the one picked when it was drafted, else the job's current one.
        resumePdf: d.linkedin.resumeVariantId ? `/api/resume-variants/${d.linkedin.resumeVariantId}/pdf` : d.jobId ? (jobs.get(d.jobId)?.resumePdf ?? null) : null,
        job: d.jobId ? (jobs.get(d.jobId) ?? null) : null,
      })),
    };
  });

  app.post('/api/linkedin/drafts/:id/sent', async (req) => {
    const { id } = idParams.parse(req.params);
    const r = await markLinkedInSent(db, o.policy, id);
    return { item: r.item, threadId: r.thread.id };
  });

  app.post('/api/linkedin/drafts/:id/replied', async (req) => {
    const { id } = idParams.parse(req.params);
    const b = z.object({ note: z.string().max(500).optional() }).strict().parse(req.body ?? {});
    const t = await markLinkedInReplied(db, id, b.note ? { note: b.note } : {});
    return { threadId: t.id, state: t.state };
  });
}
