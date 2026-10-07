import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import {
  defineActorPlugin,
  emailDraftSchema,
  type EmailAttachment,
  type EmailDraft,
  type EmailSendResult,
  type OutreachActionInput,
  type PluginContext,
} from '@jobforge/plugin-sdk';
import { buildMime, messageIdFor, toBase64Url, type MimeAttachment } from './mime.js';
import { outreachPrompt, outreachSchema, referralPrompt, referralSchema, REFERRAL_SYSTEM_PROMPT, SYSTEM_PROMPT } from './prompt.js';

export * from './mime.js';
export * from './prompt.js';

export const configSchema = z
  .object({
    /** Display name on the From header; defaults to the Gmail account's address only. */
    senderName: z.string().default(''),
    /** Appended to every email (plain text). */
    signature: z.string().default(''),
    maxWords: z.number().int().min(40).max(400).default(150),
    followupMaxWords: z.number().int().min(20).max(200).default(70),
    /** Referral asks are deliberately short. */
    referralMaxWords: z.number().int().min(30).max(200).default(90),
  })
  .strict();
export type OutreachConfig = z.infer<typeof configSchema>;

export const PLUGIN_ID = 'actor-gmail-outreach';

const outreachActor = defineActorPlugin<OutreachConfig, OutreachActionInput, EmailDraft, EmailSendResult>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.1.0',
    stage: 'actor',
    description: 'Drafts a job-specific email with the LLM; after approval, sends it from your Gmail (once).',
    configSchema,
    permissions: { domains: [], llm: true, gmail: ['send', 'read'] },
    sideEffects: 'external',
  },

  // No side effects: an LLM call and validation only.
  async prepare(ctx, input) {
    if (input.kind === 'referral_ask') return prepareReferral(ctx, input);
    const followup = input.kind === 'followup';
    const maxWords = followup ? ctx.config.followupMaxWords : ctx.config.maxWords;
    const res = await ctx.llm!.generate({
      task: 'outreach',
      system: SYSTEM_PROMPT,
      prompt: outreachPrompt(input, maxWords),
      schema: outreachSchema(maxWords, followup),
      maxTokens: 1200,
      signal: ctx.signal,
    });
    const known = new Set(input.profile.facts.map((f) => f.id));
    const factIds = res.data.fact_ids.filter((id) => known.has(id));
    if (factIds.length !== res.data.fact_ids.length) ctx.log.warn({ cited: res.data.fact_ids }, 'draft cited unknown fact ids; dropped');

    const subject = followup && input.previous ? reSubject(input.previous.subject) : (res.data.subject ?? '');
    const sig = ctx.config.signature.trim();
    return emailDraftSchema.parse({
      to: input.contact.email,
      toName: input.contact.name,
      subject,
      body: sig ? `${res.data.body}\n\n${sig}` : res.data.body,
      factIds,
      attachments: input.attachments ?? [],
      confidence: res.data.confidence,
      gmailThreadId: followup ? (input.previous?.gmailThreadId ?? null) : null,
      inReplyTo: followup ? (input.previous?.messageIds.at(-1) ?? null) : null,
      references: followup ? (input.previous?.messageIds ?? []) : [],
    });
  },

  async execute(ctx, approved, idempotencyKey) {
    const draft = emailDraftSchema.parse(approved.draft);
    const gmail = ctx.gmail;
    if (!gmail) throw new Error('Gmail is not connected');
    const messageId = messageIdFor(idempotencyKey, gmail.address);
    const sentAt = new Date();
    const attachments = await loadAttachments(draft.attachments);

    if (ctx.dryRun) {
      ctx.log.info(
        { to: draft.to, subject: draft.subject, messageId, attachments: attachments.map((a) => a.filename) },
        'DRY RUN: would send email',
      );
      return { dryRun: true, messageId, gmailId: null, gmailThreadId: draft.gmailThreadId, sentAt: sentAt.toISOString(), deduplicated: false };
    }

    // A retry after a crash mid-send must not send twice: look for our Message-ID first.
    const existing = await gmail.search!(`rfc822msgid:${messageId}`, 1);
    if (existing[0]) {
      ctx.log.warn({ messageId }, 'message already sent; not sending again');
      return { dryRun: false, messageId, gmailId: existing[0].id, gmailThreadId: existing[0].threadId, sentAt: sentAt.toISOString(), deduplicated: true };
    }

    const raw = buildMime({
      from: { name: ctx.config.senderName, address: gmail.address },
      to: { name: draft.toName, address: draft.to },
      subject: draft.subject,
      body: draft.body,
      messageId,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      date: sentAt,
      attachments,
    });
    const sent = await gmail.send!(toBase64Url(raw), draft.gmailThreadId ?? undefined);
    ctx.log.info({ to: draft.to, gmailId: sent.id, attachments: attachments.length }, 'email sent');
    return { dryRun: false, messageId, gmailId: sent.id, gmailThreadId: sent.threadId, sentAt: sentAt.toISOString(), deduplicated: false };
  },
});

export default outreachActor;

async function prepareReferral(
  ctx: PluginContext<OutreachConfig>,
  input: OutreachActionInput,
): Promise<EmailDraft> {
  const maxWords = ctx.config.referralMaxWords;
  const bullets = input.resumeBullets ?? [];
  const res = await ctx.llm!.generate({
    task: 'outreach',
    system: REFERRAL_SYSTEM_PROMPT,
    prompt: referralPrompt(input, maxWords),
    schema: referralSchema(maxWords, bullets.map((b) => b.id)),
    maxTokens: 800,
    signal: ctx.signal,
  });
  let body = res.data.body;
  // The posting link is the point of the ask; make sure it survived the LLM.
  const url = input.job?.applyUrl;
  if (url && !body.includes(url)) body = `${body}\n\nRole: ${url}`;
  const sig = ctx.config.signature.trim();
  const bulletId = bullets.some((b) => b.id === res.data.bullet_id) ? res.data.bullet_id : null;
  return emailDraftSchema.parse({
    to: input.contact.email,
    toName: input.contact.name,
    subject: res.data.subject,
    body: sig ? `${body}\n\n${sig}` : body,
    // A bullet that came from a profile fact keeps the grounding trail.
    factIds: bulletId && input.profile.facts.some((f) => f.id === bulletId) ? [bulletId] : [],
    attachments: input.attachments ?? [],
    confidence: res.data.confidence,
    resumeBulletId: bulletId,
  });
}

function reSubject(s: string): string {
  return /^re:/i.test(s.trim()) ? s.trim() : `Re: ${s.trim()}`;
}

async function loadAttachments(list: EmailAttachment[]): Promise<MimeAttachment[]> {
  const out: MimeAttachment[] = [];
  for (const a of list) {
    const data = await readFile(a.path);
    out.push({ filename: a.filename || basename(a.path), contentType: a.contentType, data });
  }
  return out;
}
