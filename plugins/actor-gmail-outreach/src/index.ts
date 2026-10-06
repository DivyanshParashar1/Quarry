import { z } from 'zod';
import {
  defineActorPlugin,
  emailDraftSchema,
  type EmailDraft,
  type EmailSendResult,
  type OutreachActionInput,
} from '@jobforge/plugin-sdk';
import { buildMime, messageIdFor, toBase64Url } from './mime.js';
import { outreachPrompt, outreachSchema, SYSTEM_PROMPT } from './prompt.js';

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
  })
  .strict();
export type OutreachConfig = z.infer<typeof configSchema>;

export const PLUGIN_ID = 'actor-gmail-outreach';

export default defineActorPlugin<OutreachConfig, OutreachActionInput, EmailDraft, EmailSendResult>({
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

    if (ctx.dryRun) {
      ctx.log.info({ to: draft.to, subject: draft.subject, messageId }, 'DRY RUN: would send email');
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
    });
    const sent = await gmail.send!(toBase64Url(raw), draft.gmailThreadId ?? undefined);
    ctx.log.info({ to: draft.to, gmailId: sent.id }, 'email sent');
    return { dryRun: false, messageId, gmailId: sent.id, gmailThreadId: sent.threadId, sentAt: sentAt.toISOString(), deduplicated: false };
  },
});

function reSubject(s: string): string {
  return /^re:/i.test(s.trim()) ? s.trim() : `Re: ${s.trim()}`;
}
