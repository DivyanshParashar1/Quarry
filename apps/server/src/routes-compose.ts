import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig, LLMClient } from '@quarry/shared';
import { getActiveProfile, getResumeVariant, getSentEmail, listSentEmails, sentEmailCounts, type DB } from '@quarry/db';
import {
  APPS_SCRIPT,
  cancelScheduled,
  composeFormSchema,
  composeProjects,
  composeRecipientInputSchema,
  composeSend,
  generateCompose,
  reconcileScheduled,
  COMPOSE_PURPOSES,
  type OutreachDeps,
} from '@quarry/core';

// Phase 24: the Compose page and the sent-mail log.

export interface ComposeRouteOptions {
  db: DB;
  config: AppConfig;
  outreachDeps?: () => Promise<OutreachDeps>;
  llm?: () => Promise<LLMClient>;
  /** Where uploaded attachments are kept (they stay: the log points at them). */
  attachmentsDir: string;
  /** MODE=live; drives the page's "Dry run" badge. */
  live: boolean;
}

const MAX_ATTACHMENT = 10 * 1024 * 1024;
const uuid = z.string().uuid();

/** What the browser may send for an attachment: an upload id or a library resume, never a path. */
const attachmentRefSchema = z.union([z.object({ uploadId: uuid }).strict(), z.object({ resumeVariantId: uuid }).strict()]);

export function registerComposeRoutes(app: FastifyInstance, o: ComposeRouteOptions): void {
  const { db } = o;
  const deps = async () => {
    if (!o.outreachDeps) throw Object.assign(new Error('Gmail sending is not configured on this server'), { statusCode: 503 });
    return o.outreachDeps();
  };
  const signature = (o.config.plugins['actor-gmail-outreach'] as { signature?: string } | undefined)?.signature ?? '';

  app.get('/api/compose/context', async () => {
    const profile = await getActiveProfile(db);
    let gmail: { connected: boolean; address: string | null } = { connected: false, address: null };
    if (o.outreachDeps) {
      const d = await o.outreachDeps().catch(() => null);
      if (d?.gmail) gmail = { connected: true, address: d.gmail.address };
    }
    return {
      mode: o.live ? 'live' : 'dry_run',
      gmail,
      signature,
      purposes: COMPOSE_PURPOSES,
      projects: composeProjects(profile),
      cooldownDays: o.config.outreach.perContactCooldownDays,
    };
  });

  app.post('/api/compose/generate', async (req, reply) => {
    const b = z
      .object({
        form: composeFormSchema,
        recipient: composeRecipientInputSchema,
        count: z.union([z.literal(1), z.literal(2)]).default(2),
        keep: z.object({ angle: z.string(), subject: z.string(), body: z.string() }).nullable().default(null),
      })
      .strict()
      .parse(req.body ?? {});
    if (!o.llm) return reply.status(503).send({ error: 'unavailable', message: 'no LLM configured' });
    const llm = await o.llm();
    return generateCompose(llm, await getActiveProfile(db), { form: b.form, recipient: b.recipient, count: b.count, keep: b.keep });
  });

  app.post('/api/compose/attachments', async (req, reply) => {
    const file = await (req as unknown as { file: () => Promise<{ toBuffer: () => Promise<Buffer>; filename: string; mimetype: string } | undefined> }).file();
    if (!file) return reply.status(400).send({ error: 'no_file' });
    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch {
      return reply.status(413).send({ error: 'too_large', message: 'max 10MB per file' });
    }
    if (buf.length > MAX_ATTACHMENT) return reply.status(413).send({ error: 'too_large', message: 'max 10MB per file' });
    const id = randomUUID();
    const filename = safeFilename(file.filename);
    const dir = join(o.attachmentsDir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), buf);
    const meta = { id, filename, contentType: file.mimetype || 'application/octet-stream', size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
    await writeFile(join(dir, '.meta.json'), JSON.stringify(meta));
    return reply.status(201).send(meta);
  });

  app.get('/api/compose/apps-script', async (_req, reply) => reply.type('text/plain; charset=utf-8').send(APPS_SCRIPT));

  app.post('/api/compose/send', async (req, reply) => {
    const b = z
      .object({
        form: z.unknown(),
        recipients: z.array(z.object({ attachments: z.array(attachmentRefSchema).max(5).default([]) }).passthrough()).min(1).max(25),
        sendAt: z.string().nullable().default(null),
        ignoreWarnings: z.boolean().default(false),
      })
      .strict()
      .parse(req.body ?? {});
    const recipients = [];
    for (const r of b.recipients) {
      const attachments = [];
      for (const ref of r.attachments) {
        const a = await resolveAttachment(ref);
        if (!a) return reply.status(422).send({ error: 'bad_attachment', message: 'an attachment is missing; upload it again' });
        attachments.push(a);
      }
      recipients.push({ ...r, attachments });
    }
    const d = await deps();
    return composeSend({ ...d, signature }, { form: b.form, recipients, sendAt: b.sendAt, ignoreWarnings: b.ignoreWarnings });
  });

  async function resolveAttachment(ref: z.infer<typeof attachmentRefSchema>) {
    if ('uploadId' in ref) {
      const dir = join(o.attachmentsDir, ref.uploadId);
      const meta = await readFile(join(dir, '.meta.json'), 'utf8').then((s) => JSON.parse(s) as { filename: string; contentType: string }).catch(() => null);
      if (!meta) return null;
      const files: string[] = await readdir(dir).catch(() => []);
      if (!files.includes(meta.filename)) return null;
      return { filename: meta.filename, contentType: meta.contentType, path: join(dir, meta.filename), resumeVariantId: null };
    }
    const v = await getResumeVariant(db, ref.resumeVariantId);
    if (!v?.pdfPath) return null;
    return { filename: `${(v.label ?? 'resume').replace(/[^\w.+ -]+/g, '').trim() || 'resume'}.pdf`, contentType: 'application/pdf', path: v.pdfPath, resumeVariantId: v.id };
  }

  // --- the sent-mail log --------------------------------------------------------
  app.get('/api/sent-emails', async (req) => {
    const q = z
      .object({
        status: z
          .string()
          .optional()
          .transform((s) => (s ? s.split(',').filter(Boolean) : undefined))
          .pipe(z.array(z.enum(['queued', 'sent', 'dry_run', 'scheduled', 'cancelled', 'failed'])).optional()),
        source: z
          .string()
          .optional()
          .transform((s) => (s ? s.split(',').filter(Boolean) : undefined)),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .strict()
      .parse(req.query);
    return {
      items: await listSentEmails(db, {
        ...(q.status ? { status: q.status } : {}),
        ...(q.source ? { source: q.source } : {}),
        ...(q.q ? { q: q.q } : {}),
        limit: q.limit,
        offset: q.offset,
      }),
      counts: await sentEmailCounts(db),
    };
  });

  app.get('/api/sent-emails/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const s = await getSentEmail(db, id);
    return s ?? reply.status(404).send({ error: 'not_found' });
  });

  /** Download a logged attachment (only paths the log itself recorded). */
  app.get('/api/sent-emails/:id/attachments/:n', async (req, reply) => {
    const { id, n } = z.object({ id: uuid, n: z.coerce.number().int().min(0).max(10) }).parse(req.params);
    const s = await getSentEmail(db, id);
    const a = (s?.attachments as Array<{ filename: string; contentType: string; path?: string }> | undefined)?.[n];
    if (!a?.path) return reply.status(404).send({ error: 'not_found' });
    const buf = await readFile(a.path).catch(() => null);
    if (!buf) return reply.status(410).send({ error: 'gone', message: 'the file is no longer on disk' });
    return reply.type(a.contentType).header('content-disposition', `attachment; filename="${safeFilename(a.filename)}"`).send(buf);
  });

  app.post('/api/sent-emails/:id/cancel', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return cancelScheduled(await deps(), id);
  });

  app.post('/api/sent-emails/reconcile', async () => reconcileScheduled(await deps()));
}

function safeFilename(name: string): string {
  const n = basename(name).replace(/[^\w.+() -]+/g, '_').replace(/^\.+/, '').slice(0, 150);
  return n || 'attachment';
}
