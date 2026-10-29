import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LLMClient, Profile } from '@quarry/shared';
import { emailDraftSchema, type EmailAttachment, type EmailDraft } from '@quarry/plugin-sdk';
import {
  appendEvent,
  createReviewItem,
  findCompanyByName,
  findContactByEmail,
  getReviewItem,
  lastAskedAt,
  listSentEmails,
  liveSendsSince,
  recordSentEmail,
  transitionReviewItem,
  updatePendingDraft,
  updateSentEmail,
  upsertCompany,
  upsertContact,
  AmbiguousContactError,
  type DB,
  type SentEmailRow,
} from '@quarry/db';
import { OUTREACH_ACTOR, openThreadForSend, sendApprovedNow, type OutreachDeps } from './outreach.js';

// Phase 24: the Compose page. The user writes everything that makes the mail
// personal (about the receiver, what it's for, which projects, notes in the
// body); the LLM only turns that into two drafts. Pressing Send (or Schedule)
// is the approval: one `compose` review item per recipient, created approved.

// Same rules as the Gmail actor's prompt checks (the actor is not a runtime dependency of core).
const PLACEHOLDER_RE = /\[[A-Z][^\]]{0,40}\]|\{\{[^}]*\}\}|<(?:name|company|role)>/i;
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

export const COMPOSE_PURPOSES = ['referral', 'intro', 'followup', 'thanks', 'chat'] as const;
export type ComposePurpose = (typeof COMPOSE_PURPOSES)[number];
const PURPOSE_TEXT: Record<ComposePurpose, string> = {
  referral: 'Ask for a referral for a specific role (one clear, easy ask).',
  intro: 'A first introduction; ask for a short chat or who the right person is.',
  followup: 'Follow up on an earlier conversation or email.',
  thanks: 'Thank them (e.g. for a referral, a chat, or advice). No new ask unless the notes say so.',
  chat: 'Ask for a short coffee chat / call to learn about their work.',
};
export const COMPOSE_LENGTHS = { short: 90, medium: 150, full: 230 } as const;
export type ComposeLength = keyof typeof COMPOSE_LENGTHS;

export const composeFormSchema = z
  .object({
    purpose: z.enum(COMPOSE_PURPOSES).default('referral'),
    /** What the mail is about, in the user's words. */
    about: z.string().trim().max(4000).default(''),
    /** Ids of the profile's project facts to mention. */
    projectIds: z.array(z.string()).max(10).default([]),
    /** Extra detail on the projects (free text). */
    projectNotes: z.string().trim().max(4000).default(''),
    tone: z.enum(['formal', 'neutral', 'casual']).default('neutral'),
    length: z.enum(['short', 'medium', 'full']).default('medium'),
  })
  .strict();
export type ComposeForm = z.infer<typeof composeFormSchema>;

export const composeRecipientInputSchema = z
  .object({
    toName: z.string().trim().max(200).default(''),
    /** Everything the user knows about this person: who they are, how they're connected, what to reference. */
    receiverInfo: z.string().trim().max(4000).default(''),
    /** Whatever is already in the body: must-include notes. */
    notes: z.string().max(10_000).default(''),
  })
  .strict();
export type ComposeRecipientInput = z.infer<typeof composeRecipientInputSchema>;

export interface ComposeVariant {
  angle: string;
  subject: string;
  body: string;
}

export const COMPOSE_SYSTEM_PROMPT = `You help a job seeker write one personal email in their own voice. Everything that makes it personal comes from what they wrote: who the receiver is, what the mail is about, their notes, and the projects they picked.

Rules:
- Use ONLY what the sender provided. Never invent facts about the receiver (no guessed titles, achievements, shared history or compliments that aren't in the input), and never invent experience, numbers or skills for the sender beyond the listed projects and notes.
- Every point in the sender's notes must appear in the email (reworded is fine).
- Mention the selected projects concretely and briefly; if none are selected, don't bring up projects.
- Plain text. No markdown, no emojis, no "I hope this email finds you well", no filler.
- Start with "Hi <first name>," when a name is given, else "Hi,". No signature; it is added automatically.
- Never leave placeholders such as [Name] or {{company}}; write the real words, or leave the detail out.
- Each variant takes a clearly different angle (e.g. leading with the connection vs. leading with a project), with its own subject line.`;

/** The candidate's projects as the Compose form lists them. */
export function composeProjects(profile: Profile | null): Array<{ id: string; content: string; tags: string[] }> {
  return (profile?.facts ?? []).filter((f) => f.kind === 'project').map((f) => ({ id: f.id, content: f.content, tags: f.tags }));
}

export function composePrompt(
  form: ComposeForm,
  r: ComposeRecipientInput,
  profile: Profile | null,
  o: { count: 1 | 2; keep?: ComposeVariant | null } = { count: 2 },
): string {
  const maxWords = COMPOSE_LENGTHS[form.length];
  const app = profile?.preferences.application;
  const sender = [app?.first_name, app?.last_name].filter(Boolean).join(' ');
  const chosen = composeProjects(profile).filter((p) => form.projectIds.includes(p.id));
  const lines = [
    '# Purpose',
    PURPOSE_TEXT[form.purpose],
    '',
    '# What the mail is about (sender\'s words)',
    form.about || '(not given)',
    '',
    '# The receiver (sender\'s words; the only source about them)',
    r.toName ? `Name: ${r.toName}` : 'Name: (not given)',
    r.receiverInfo || '(nothing else given)',
    '',
    '# Sender',
    sender ? `Name: ${sender}` : '(name not given)',
    app?.current_title || app?.current_company ? `Currently: ${[app.current_title, app.current_company].filter(Boolean).join(' at ')}` : '',
    '',
    '# Projects to mention',
    chosen.length ? chosen.map((p) => `- [${p.id}] ${p.content}`).join('\n') : '(none selected)',
    form.projectNotes ? `Extra detail from the sender: ${form.projectNotes}` : '',
    '',
    '# Sender\'s notes (must all appear in the email)',
    r.notes.trim() || '(none)',
    '',
    `Tone: ${form.tone}. At most ${maxWords} words per body. Subject under 9 words.`,
  ];
  if (o.count === 1 && o.keep) {
    lines.push('', '# Already on screen (write ONE new variant with a different angle from this one)', `Subject: ${o.keep.subject}`, o.keep.body);
  } else {
    lines.push('', `Write ${o.count} variant${o.count === 1 ? '' : 's'}.`);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function composeSchema(count: 1 | 2, maxWords: number) {
  const variant = z.object({
    angle: z.string().trim().min(2).max(80).describe('a few words naming the angle, e.g. "leads with the connection"'),
    subject: z.string().trim().min(3).max(120),
    body: z
      .string()
      .trim()
      .min(30)
      .refine((b) => !PLACEHOLDER_RE.test(b), 'contains a placeholder like [Name]; write the real text')
      .refine((b) => wordCount(b) <= Math.ceil(maxWords * 1.25), `longer than ${maxWords} words`),
  });
  return z.object({ variants: z.array(variant).length(count) });
}

export interface GenerateComposeInput {
  form: ComposeForm;
  recipient: ComposeRecipientInput;
  /** 1 = regenerate one variant while `keep` stays on screen. */
  count?: 1 | 2;
  keep?: ComposeVariant | null;
  signal?: AbortSignal;
}

export async function generateCompose(llm: LLMClient, profile: Profile | null, input: GenerateComposeInput): Promise<{ variants: ComposeVariant[]; model: string }> {
  const count = input.count ?? 2;
  const form = composeFormSchema.parse(input.form);
  const recipient = composeRecipientInputSchema.parse(input.recipient);
  const res = await llm.generate({
    task: 'outreach',
    system: COMPOSE_SYSTEM_PROMPT,
    prompt: composePrompt(form, recipient, profile, { count, keep: input.keep ?? null }),
    schema: composeSchema(count, COMPOSE_LENGTHS[form.length]),
    maxTokens: 2000,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { variants: res.data.variants, model: res.model };
}

// ---------------------------------------------------------------------------
// Pre-send checks
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>".]+(\.[^\s@<>".]+)+$/;
const MENTIONS_ATTACHMENT_RE = /\b(attached|attaching|attachment|enclosed|find my (resume|cv))\b/i;

/** Text-only checks (no DB): blocking problems and warnings for one mail. */
export function checkComposeText(m: { to: string; subject: string; body: string; attachmentCount: number }): { blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];
  if (!m.to.trim()) blocking.push('To is empty');
  else if (!EMAIL_RE.test(m.to.trim())) blocking.push(`"${m.to}" is not a valid email address`);
  if (!m.body.trim()) blocking.push('Body is empty');
  if (!m.subject.trim()) warnings.push('Subject is empty');
  if (MENTIONS_ATTACHMENT_RE.test(m.body) && m.attachmentCount === 0) warnings.push('The body mentions an attachment but nothing is attached');
  if (PLACEHOLDER_RE.test(m.body) || PLACEHOLDER_RE.test(m.subject)) warnings.push('There is a leftover placeholder like [Name] or {{company}}');
  return { blocking, warnings };
}

// ---------------------------------------------------------------------------
// Sending (one Send click = one batch; one review item per recipient)
// ---------------------------------------------------------------------------

export const composeAttachmentSchema = z
  .object({ filename: z.string().min(1).max(200), contentType: z.string().min(1).max(100), path: z.string().min(1), resumeVariantId: z.string().uuid().nullable().default(null) })
  .strict();

export const composeOutgoingSchema = z
  .object({
    to: z.string().trim().max(320),
    toName: z.string().trim().max(200).default(''),
    /** Optional: lets Quarry match or create the contact (cooldown + reply tracking). */
    company: z.string().trim().max(200).default(''),
    receiverInfo: z.string().max(4000).default(''),
    subject: z.string().max(200),
    body: z.string().max(10_000),
    attachments: z.array(composeAttachmentSchema).max(5).default([]),
    /** Logged: the variants the user saw, which one they picked, and that variant as generated. */
    variants: z.array(z.object({ angle: z.string(), subject: z.string(), body: z.string() })).max(6).default([]),
    chosenVariant: z.number().int().min(0).max(5).nullable().default(null),
    notes: z.string().max(10_000).default(''),
  })
  .strict();
export type ComposeOutgoing = z.infer<typeof composeOutgoingSchema>;

export const composeSendSchema = z
  .object({
    form: composeFormSchema,
    recipients: z.array(composeOutgoingSchema).min(1).max(25),
    /** ISO time: schedule instead of sending now (Gmail draft + the user's Apps Script). */
    sendAt: z.string().datetime({ offset: true }).nullable().default(null),
    /** The user saw the warnings and chose to send anyway. */
    ignoreWarnings: z.boolean().default(false),
  })
  .strict();
export type ComposeSendInput = z.infer<typeof composeSendSchema>;

export type ComposeSendStatus = 'sent' | 'dry_run' | 'scheduled' | 'blocked' | 'warnings' | 'failed';
export interface ComposeSendResult {
  to: string;
  status: ComposeSendStatus;
  blocking: string[];
  warnings: string[];
  reviewItemId?: string;
  sentEmailId?: string;
  error?: string;
}

export interface ComposeDeps extends OutreachDeps {
  /** Appended to every body (the Gmail actor's signature). */
  signature?: string;
}

const DAY = 86_400_000;

/**
 * Check every recipient first; when anything blocks (or warns without
 * `ignoreWarnings`), nothing in the batch is sent and the problems come back.
 */
export async function composeSend(deps: ComposeDeps, raw: unknown): Promise<{ batchKey: string; mode: 'live' | 'dry_run'; results: ComposeSendResult[] }> {
  const input = composeSendSchema.parse(raw);
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const batchKey = randomUUID();
  const mode = deps.dryRun ? 'dry_run' : 'live';
  if (input.sendAt && new Date(input.sendAt).getTime() < now.getTime() - 60_000) {
    return { batchKey, mode, results: input.recipients.map((r) => ({ to: r.to, status: 'blocked', blocking: ['The scheduled time is in the past'], warnings: [] })) };
  }

  // 1) checks, nothing written yet
  const checked = [];
  for (const r of input.recipients) {
    const c = checkComposeText({ to: r.to, subject: r.subject, body: r.body, attachmentCount: r.attachments.length });
    const contact = c.blocking.length ? null : await findContactByEmail(db, r.to.trim());
    if (contact && contact.status !== 'active') c.blocking.push(`${r.to} is marked ${contact.status.replace(/_/g, ' ')}`);
    if (contact && (input.form.purpose === 'referral' || input.form.purpose === 'intro') && deps.policy.perContactCooldownDays > 0) {
      const last = await lastAskedAt(db, contact.id);
      if (last && (last.status !== 'executed' || last.at.getTime() + deps.policy.perContactCooldownDays * DAY > now.getTime())) {
        c.blocking.push(
          last.status === 'executed'
            ? `${r.to} was already asked on ${last.at.toISOString().slice(0, 10)} (cooldown ${deps.policy.perContactCooldownDays} days)`
            : `${r.to} already has a ${last.status} ask queued`,
        );
      }
    }
    checked.push({ r, contact, ...c });
  }
  const dupes = duplicates(input.recipients.map((r) => r.to.trim().toLowerCase()));
  for (const c of checked) if (dupes.has(c.r.to.trim().toLowerCase())) c.blocking.push(`${c.r.to} appears twice in this batch`);
  if (!deps.dryRun && !input.sendAt) {
    const sent = await liveSendsSince(db, OUTREACH_ACTOR, new Date(now.getTime() - DAY));
    if (sent + checked.length > deps.policy.senderDailyLimit) {
      for (const c of checked) c.blocking.push(`Gmail sender limit: ${sent} sent in the last 24h, limit ${deps.policy.senderDailyLimit}`);
    }
  }
  const anyBlocking = checked.some((c) => c.blocking.length);
  const anyWarnings = checked.some((c) => c.warnings.length);
  if (anyBlocking || (anyWarnings && !input.ignoreWarnings)) {
    const results: ComposeSendResult[] = checked.map((c) => {
      if (c.blocking.length) return { to: c.r.to, status: 'blocked', blocking: c.blocking, warnings: c.warnings };
      if (c.warnings.length) return { to: c.r.to, status: 'warnings', blocking: [], warnings: c.warnings };
      return { to: c.r.to, status: 'blocked', blocking: ['Not sent: another recipient in this batch has a problem'], warnings: [] };
    });
    return { batchKey, mode, results };
  }

  // 2) one approved review item + queued log row per recipient, then send
  const results: ComposeSendResult[] = [];
  for (const c of checked) {
    const { r } = c;
    const contact = c.contact ?? (await ensureContact(db, r));
    const sig = deps.signature?.trim();
    const body = sig && !r.body.includes(sig) ? `${r.body.trimEnd()}\n\n${sig}` : r.body.trim();
    const draft: EmailDraft = emailDraftSchema.parse({
      to: r.to.trim(),
      toName: r.toName,
      subject: r.subject.trim() || '(no subject)',
      body,
      attachments: r.attachments as EmailAttachment[],
      purpose: input.form.purpose,
      sendAt: input.sendAt,
    });
    const picked = r.chosenVariant !== null ? (r.variants[r.chosenVariant] ?? null) : null;
    let item = await createReviewItem(db, {
      kind: 'compose',
      pluginId: OUTREACH_ACTOR,
      jobId: null,
      contactId: contact?.id ?? null,
      companyId: contact?.companyId ?? null,
      // As generated (the picked variant), so the log shows what the user changed.
      draft: picked ? { ...draft, subject: picked.subject, body: picked.body } : draft,
    });
    // original_draft keeps the picked variant as generated; draft is what goes out.
    if (picked) await updatePendingDraft(db, item.id, draft);
    item = (await transitionReviewItem(db, item.id, ['pending'], 'approved', { decided: true, decidedBy: 'human', decisionNote: input.sendAt ? `compose: scheduled for ${input.sendAt}` : 'compose: Send' }))!;
    const log = await recordSentEmail(db, {
      reviewItemId: item.id,
      source: 'compose',
      status: 'queued',
      toAddress: draft.to,
      toName: draft.toName || null,
      subject: draft.subject,
      body: draft.body,
      contactId: item.contactId,
      companyId: item.companyId,
      batchKey,
      scheduledFor: input.sendAt ? new Date(input.sendAt) : null,
      input: {
        form: input.form,
        recipient: { toName: r.toName, company: r.company, receiverInfo: r.receiverInfo, notes: r.notes },
        variants: r.variants,
        chosenVariant: r.chosenVariant,
        editedAfterPick: picked ? picked.subject !== draft.subject || picked.body !== r.body.trim() : null,
        recipientsInBatch: input.recipients.length,
      },
      original: picked ? { subject: picked.subject, body: picked.body, angle: picked.angle } : null,
    });
    try {
      const out = await sendApprovedNow(deps, item.id);
      const after = await getReviewItem(db, item.id);
      const status: ComposeSendStatus = !out.ok ? 'failed' : deps.dryRun ? 'dry_run' : input.sendAt ? 'scheduled' : 'sent';
      results.push({ to: draft.to, status, blocking: [], warnings: c.warnings, reviewItemId: item.id, sentEmailId: log.id, ...(out.error ? { error: out.error } : after?.error ? { error: after.error } : {}) });
    } catch (err) {
      results.push({ to: draft.to, status: 'failed', blocking: [], warnings: c.warnings, reviewItemId: item.id, sentEmailId: log.id, error: (err as Error).message });
    }
  }
  await appendEvent(db, { kind: 'compose.sent', subjectType: 'compose_batch', subjectId: batchKey, payload: { mode, scheduled: input.sendAt, results: results.map((r) => ({ to: r.to, status: r.status })) } });
  return { batchKey, mode, results };
}

function duplicates(xs: string[]): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const x of xs) (seen.has(x) ? out : seen).add(x);
  return out;
}

/** Match or create the contact when the user named the company (enables cooldown + reply tracking). */
async function ensureContact(db: DB, r: ComposeOutgoing) {
  if (!r.company.trim() || !r.toName.trim()) return null;
  let company = await findCompanyByName(db, r.company.trim());
  if (!company) {
    await upsertCompany(db, { name: r.company.trim(), domain: null });
    company = await findCompanyByName(db, r.company.trim());
  }
  if (!company) return null;
  try {
    const { contact } = await upsertContact(db, { companyId: company.id, name: r.toName.trim(), email: r.to.trim(), source: 'compose' });
    return contact;
  } catch (err) {
    if (err instanceof AmbiguousContactError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Scheduled sends: reconcile + cancel (the Apps Script does the sending)
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  checked: number;
  sent: number;
  cancelled: number;
  waiting: number;
  errors: string[];
}

/**
 * For each scheduled mail: draft still there → waiting; gone with a sent
 * message in its thread → sent (thread opened for reply tracking); gone with
 * nothing sent → the user deleted it in Gmail → cancelled.
 */
export async function reconcileScheduled(deps: OutreachDeps): Promise<ReconcileResult> {
  const out: ReconcileResult = { checked: 0, sent: 0, cancelled: 0, waiting: 0, errors: [] };
  const g = deps.gmail;
  if (deps.dryRun || !g?.draftExists || !g.sentMessageInThread) return out;
  const rows = await listSentEmails(deps.db, { status: ['scheduled'], limit: 500 });
  for (const s of rows) {
    out.checked++;
    try {
      if (s.gmailDraftId && (await g.draftExists(s.gmailDraftId))) {
        out.waiting++;
        continue;
      }
      const msg = s.gmailThreadId ? await g.sentMessageInThread(s.gmailThreadId) : null;
      if (!msg) {
        await updateSentEmail(deps.db, s.id, { status: 'cancelled', error: 'draft was deleted in Gmail before it was sent' });
        out.cancelled++;
        continue;
      }
      let threadId: string | null = null;
      const item = s.reviewItemId ? await getReviewItem(deps.db, s.reviewItemId) : null;
      if (item?.contactId) threadId = (await openThreadForSend(deps.db, item, { gmailThreadId: msg.threadId, messageId: s.messageId ?? '' }, msg.at, null)).id;
      await updateSentEmail(deps.db, s.id, { status: 'sent', gmailId: msg.id, sentAt: msg.at, threadId });
      await appendEvent(deps.db, { kind: 'outreach.sent', subjectType: 'review_item', subjectId: s.reviewItemId ?? s.id, payload: { kind: 'compose', to: s.toAddress, scheduled: true, gmailId: msg.id } });
      out.sent++;
    } catch (err) {
      out.errors.push(`${s.toAddress}: ${(err as Error).message}`);
    }
  }
  return out;
}

export async function cancelScheduled(deps: OutreachDeps, sentEmailId: string): Promise<SentEmailRow> {
  const [s] = await listSentEmails(deps.db, { ids: [sentEmailId], limit: 1 });
  if (!s) throw Object.assign(new Error('not found'), { statusCode: 404 });
  if (s.status !== 'scheduled') throw Object.assign(new Error(`this mail is ${s.status}, not scheduled`), { statusCode: 409 });
  if (s.gmailDraftId) {
    if (!deps.gmail?.deleteDraft) throw Object.assign(new Error('Gmail is not connected'), { statusCode: 503 });
    if (deps.gmail.sentMessageInThread && s.gmailThreadId && !(await deps.gmail.draftExists?.(s.gmailDraftId))) {
      // Already gone: let reconcile decide whether it went out.
      await reconcileScheduled(deps);
      const [after] = await listSentEmails(deps.db, { ids: [sentEmailId], limit: 1 });
      if (after?.status !== 'scheduled') throw Object.assign(new Error(`too late: this mail is already ${after?.status}`), { statusCode: 409 });
    }
    await deps.gmail.deleteDraft(s.gmailDraftId);
  }
  const row = (await updateSentEmail(deps.db, s.id, { status: 'cancelled', error: 'cancelled from Quarry' }))!;
  await appendEvent(deps.db, { kind: 'compose.cancelled', subjectType: 'sent_email', subjectId: s.id, payload: { to: s.toAddress } });
  return row;
}

/**
 * The Google Apps Script the user pastes into script.google.com once. Every 5
 * minutes (on Google's servers, Quarry can be off) it sends the drafts whose
 * X-Quarry-Send-At time has come. Only drafts carrying that header are touched.
 */
export const APPS_SCRIPT = `// Quarry scheduled send — paste into https://script.google.com (New project), save,
// then run "install" once and allow access. It checks your Gmail drafts every 5 minutes
// and sends the ones Quarry scheduled (header X-Quarry-Send-At) once their time has come.
// Other drafts are never touched. To stop: run "uninstall" (or delete the project).

function install() {
  uninstall();
  ScriptApp.newTrigger('sendDueQuarryDrafts').timeBased().everyMinutes(5).create();
  sendDueQuarryDrafts();
}

function uninstall() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDueQuarryDrafts') ScriptApp.deleteTrigger(t);
  });
}

function sendDueQuarryDrafts() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var now = Date.now();
    GmailApp.getDrafts().forEach(function (draft) {
      var at = draft.getMessage().getHeader('X-Quarry-Send-At');
      if (!at) return;
      var when = Date.parse(at);
      if (isNaN(when) || when > now) return;
      try {
        draft.send();
      } catch (e) {
        console.error('Quarry: could not send draft ' + draft.getId() + ': ' + e);
      }
    });
  } finally {
    lock.releaseLock();
  }
}
`;
