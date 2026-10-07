import { randomUUID } from 'node:crypto';
import { JobForgeError, type AppConfig, type Logger } from '@jobforge/shared';
import {
  emailDraftPatchSchema,
  emailDraftSchema,
  linkedinNoteDraftPatchSchema,
  linkedinNoteDraftSchema,
  type ApprovedDraft,
  type EmailAttachment,
  type EmailDraft,
  type EmailSendResult,
  type GmailTrackEvent,
  type Job,
  type OutreachActionInput,
} from '@jobforge/plugin-sdk';
import {
  appendEvent,
  approvedDueItems,
  batchIdForThread,
  cancelPendingFollowups,
  committedAsksForJob,
  getBatch,
  lastAskedAt,
  markBatchReplied,
  refreshBatchCounts,
  updateBatch,
  claimAction,
  confirmContactEmail,
  contactsEmailedAtCompanySince,
  countEvents,
  createReviewItem,
  createThread,
  executedItemsForThread,
  finishAction,
  getActiveProfile,
  getContact,
  getReviewItem,
  getState,
  getThread,
  jobsToMatch,
  latestRenderedResumeForJob,
  latestSentThreadToEmail,
  liveSendsSince,
  markThread,
  openOutreachForContact,
  recordFollowupSent,
  releaseLease,
  restartAction,
  setContactStatus,
  setState,
  threadsByGmailIds,
  threadsDueForFollowup,
  threadsForContact,
  transitionReviewItem,
  tryLease,
  updatePendingDraft,
  type DB,
  type ReviewItemRow,
  type ThreadRow,
} from '@jobforge/db';
import { requireGmail } from './capabilities.js';
import { loadCompanyRef } from './contacts-runner.js';
import { buildContext, type ContextDeps, type PluginRegistry } from './plugins.js';

// Outreach engine (PLAN.md §8 Phase 3, §9 safety rules):
//   draft (actor.prepare, no side effects) -> review_items(pending)
//   -> human edit / approve / reject
//   -> send tick: caps + spacing, then actor.execute with a core-built ApprovedDraft
//   -> tracker: replies/bounces close threads and cancel follow-ups.

export const OUTREACH_ACTOR = 'actor-gmail-outreach';
export const GMAIL_TRACKER = 'tracker-gmail';
export type OutreachPolicy = AppConfig['outreach'];

const DAY = 86_400_000;
const MAX_SEND_ATTEMPTS = 3;
const STATE_NEXT_SEND = 'outreach.nextSendAt';
const STATE_TRACKER_CURSOR = 'tracker.gmail.cursor';

export type OutreachErrorCode =
  | 'cooldown'
  | 'job_cap'
  | 'not_found'
  | 'invalid_state'
  | 'no_email'
  | 'contact_inactive'
  | 'duplicate'
  | 'company_cap'
  | 'no_profile'
  | 'job_closed';

export class OutreachError extends JobForgeError {
  constructor(
    message: string,
    readonly code: OutreachErrorCode,
  ) {
    super(message);
  }
}

export interface OutreachDeps extends Omit<ContextDeps, 'signal' | 'log'> {
  db: DB;
  registry: PluginRegistry;
  log: Logger;
  policy: OutreachPolicy;
  now?: () => Date;
  random?: () => number;
}

// ---------------------------------------------------------------------------
// ApprovedDraft: only this module can mint one, and only from an approved row.
// ---------------------------------------------------------------------------

const minted = new WeakSet<object>();

function approvedDraftFrom(item: ReviewItemRow): ApprovedDraft<EmailDraft> {
  if (item.status !== 'approved') throw new OutreachError(`review item ${item.id} is ${item.status}, not approved`, 'invalid_state');
  const d = Object.freeze({ reviewItemId: item.id, draft: Object.freeze(emailDraftSchema.parse(item.draft)) });
  minted.add(d);
  return d as unknown as ApprovedDraft<EmailDraft>;
}

export function isCoreApproved(d: unknown): boolean {
  return typeof d === 'object' && d !== null && minted.has(d);
}

// ---------------------------------------------------------------------------
// Drafting and review decisions
// ---------------------------------------------------------------------------

/** An open job as actors see it (throws job_closed when it's gone). */
export async function loadJobForOutreach(db: DB, jobId: string): Promise<Job> {
  return loadJob(db, jobId);
}

async function loadJob(db: DB, jobId: string): Promise<Job> {
  const [j] = await jobsToMatch(db, '', { rescore: true, jobIds: [jobId] });
  if (!j) throw new OutreachError(`job ${jobId} not found or closed`, 'job_closed');
  return j;
}

/** Ask the actor for a first-email draft to a contact (optionally about a job) and queue it for review. */
export async function draftOutreach(
  deps: OutreachDeps,
  opts: { contactId: string; jobId?: string | null; force?: boolean },
): Promise<ReviewItemRow> {
  const { db } = deps;
  const contact = await getContact(db, opts.contactId);
  if (!contact) throw new OutreachError(`contact ${opts.contactId} not found`, 'not_found');
  if (contact.status !== 'active') throw new OutreachError(`${contact.name} is marked ${contact.status}`, 'contact_inactive');
  if (!contact.email) throw new OutreachError(`${contact.name} has no email yet; add one or run \`jf contacts enrich\``, 'no_email');
  if (!opts.force) {
    if ((await openOutreachForContact(db, contact.id)).length) {
      throw new OutreachError(`an email to ${contact.name} is already in the review queue`, 'duplicate');
    }
    if ((await threadsForContact(db, contact.id)).some((t) => t.state === 'sent')) {
      throw new OutreachError(`${contact.name} was already emailed; follow-ups are drafted automatically`, 'duplicate');
    }
  }
  const profile = await getActiveProfile(db);
  if (!profile) throw new OutreachError('no profile loaded; run `jf profile load`', 'no_profile');
  const job = opts.jobId ? await loadJob(db, opts.jobId) : null;
  const company = (await loadCompanyRef(db, contact.companyId))!;

  const attachments = job ? await resolveResumeAttachment(db, job.id) : [];
  const input: OutreachActionInput = {
    kind: 'outreach',
    job,
    company,
    contact: { ...company.contacts.find((c) => c.id === contact.id)!, email: contact.email },
    profile,
    attachments,
  };
  const draft = await prepare(deps, OUTREACH_ACTOR, input);
  const item = await createReviewItem(db, {
    kind: 'outreach',
    pluginId: OUTREACH_ACTOR,
    jobId: job?.id ?? null,
    contactId: contact.id,
    companyId: contact.companyId,
    draft,
  });
  await appendEvent(db, { kind: 'review.created', subjectType: 'review_item', subjectId: item.id, payload: { kind: 'outreach', contactId: contact.id, jobId: job?.id ?? null } });
  return item;
}

async function prepare(deps: OutreachDeps, pluginId: string, input: OutreachActionInput): Promise<EmailDraft> {
  return emailDraftSchema.parse(await prepareDraft(deps, pluginId, input));
}

/** Validate a stored draft against its actor's schema (email or LinkedIn note). */
export function parseDraftFor(pluginId: string, draft: unknown): Record<string, unknown> {
  return pluginId === OUTREACH_ACTOR ? emailDraftSchema.parse(draft) : linkedinNoteDraftSchema.parse(draft);
}

/** Run an outreach-style actor's prepare() (no side effects) and validate the draft. */
export async function prepareDraft(deps: OutreachDeps, pluginId: string, input: OutreachActionInput): Promise<Record<string, unknown>> {
  const actor = deps.registry.actor(pluginId);
  const log = deps.log.child({ plugin: pluginId });
  const ctx = buildContext(actor, { ...deps, log, signal: AbortSignal.timeout(5 * 60_000) });
  return parseDraftFor(pluginId, await actor.plugin.prepare(ctx, input));
}

/** Edit a pending draft (subject, body, recipient). */
export async function editDraft(db: DB, id: string, patch: unknown): Promise<ReviewItemRow> {
  const item = await getReviewItem(db, id);
  if (!item) throw new OutreachError(`review item ${id} not found`, 'not_found');
  if (item.status !== 'pending') throw new OutreachError(`only pending items can be edited (this one is ${item.status})`, 'invalid_state');
  if (item.kind === 'attention') throw new OutreachError('attention items have nothing to edit', 'invalid_state');
  const p = item.pluginId === OUTREACH_ACTOR ? emailDraftPatchSchema.parse(patch) : linkedinNoteDraftPatchSchema.parse(patch);
  const merged = parseDraftFor(item.pluginId, { ...(item.draft as object), ...p });
  const updated = await updatePendingDraft(db, id, merged);
  if (!updated) throw new OutreachError('item changed state while editing', 'invalid_state');
  await appendEvent(db, { kind: 'review.edited', subjectType: 'review_item', subjectId: id, payload: { fields: Object.keys(p) } });
  return updated;
}

export interface CapCheck {
  ok: boolean;
  emailedThisWeek: number;
  limit: number | null;
}

/**
 * Optional "at most N people at one company per week" for cold outreach.
 * Off by default since Phase 8 (user-approved); referral asks are governed by
 * the per-job cap and the per-contact cooldown instead.
 */
export async function checkCompanyCap(db: DB, item: ReviewItemRow, policy: OutreachPolicy, now: Date, override = item.overrideCompanyCap): Promise<CapCheck> {
  const limit = policy.perCompanyPerWeek;
  if (limit === null || item.kind !== 'outreach' || !item.companyId) return { ok: true, emailedThisWeek: 0, limit };
  const emailed = await contactsEmailedAtCompanySince(db, item.companyId, new Date(now.getTime() - 7 * DAY));
  const already = item.contactId !== null && emailed.includes(item.contactId);
  return { ok: override || already || emailed.length < limit, emailedThisWeek: emailed.length, limit };
}

/**
 * The only path to an external side effect. Approving queues the email for the
 * send loop; caps are checked now (for early feedback) and again at send time.
 */
export async function approveReviewItem(
  db: DB,
  policy: OutreachPolicy,
  id: string,
  opts: { overrideCompanyCap?: boolean; note?: string; now?: Date } = {},
): Promise<ReviewItemRow> {
  const item = await getReviewItem(db, id);
  if (!item) throw new OutreachError(`review item ${id} not found`, 'not_found');
  if (item.status !== 'pending') throw new OutreachError(`item is ${item.status}, not pending`, 'invalid_state');
  if (item.kind === 'attention') {
    // "Fixed it": the paused loop resumes the next time it checks (see syncLinkedInAttention).
    const ok = await transitionReviewItem(db, id, ['pending'], 'approved', { decided: true, decisionNote: opts.note ?? 'resolved' });
    if (!ok) throw new OutreachError('item changed state while approving', 'invalid_state');
    await appendEvent(db, { kind: 'review.approved', subjectType: 'review_item', subjectId: id, payload: { kind: 'attention' } });
    return ok;
  }
  parseDraftFor(item.pluginId, item.draft);
  if (item.contactId) {
    const c = await getContact(db, item.contactId);
    if (!c || c.status !== 'active') throw new OutreachError(`contact is ${c?.status ?? 'missing'}`, 'contact_inactive');
  }
  const override = opts.overrideCompanyCap ?? false;
  await assertReferralLimits(db, policy, item, opts.now ?? new Date());
  const cap = await checkCompanyCap(db, item, policy, opts.now ?? new Date(), override);
  if (!cap.ok) {
    throw new OutreachError(
      `already emailed ${cap.emailedThisWeek} people at this company in the last 7 days (limit ${cap.limit}); approve with the company-cap override to send anyway`,
      'company_cap',
    );
  }
  const approved = await transitionReviewItem(db, id, ['pending'], 'approved', {
    decided: true,
    decisionNote: opts.note ?? null,
    overrideCompanyCap: override,
    error: null,
  });
  if (!approved) throw new OutreachError('item changed state while approving', 'invalid_state');
  await appendEvent(db, { kind: 'review.approved', subjectType: 'review_item', subjectId: id, payload: { overrideCompanyCap: override } });
  return approved;
}

/**
 * Phase 8 product throttles, checked at approval and again right before an
 * ask goes out: a person is never asked twice within the cooldown (any job,
 * any channel), and a job never gets more than its batch's referral cap.
 */
export async function referralLimitProblem(db: DB, policy: OutreachPolicy, item: ReviewItemRow, now: Date): Promise<{ code: 'cooldown' | 'job_cap'; message: string } | null> {
  if (item.kind !== 'outreach' && item.kind !== 'referral_ask') return null;
  if (item.contactId && policy.perContactCooldownDays > 0) {
    const last = await lastAskedAt(db, item.contactId, item.id);
    const until = last ? new Date(last.at.getTime() + policy.perContactCooldownDays * DAY) : null;
    // Pending/approved asks elsewhere block too: two fan-outs must not both queue the same person.
    if (last && (last.status !== 'executed' || (until && until > now))) {
      return {
        code: 'cooldown',
        message:
          last.status === 'executed'
            ? `this person was asked on ${last.at.toISOString().slice(0, 10)}; cooldown is ${policy.perContactCooldownDays} days`
            : `this person already has a ${last.status} ask${last.jobId && last.jobId !== item.jobId ? ' for another job' : ''}`,
      };
    }
  }
  if (item.kind === 'referral_ask' && item.jobId) {
    const batch = item.batchId ? await getBatch(db, item.batchId) : null;
    const cap = batch?.requestedCount ?? policy.perJobReferralCap;
    const committed = await committedAsksForJob(db, item.jobId, item.id);
    if (committed >= cap) return { code: 'job_cap', message: `${committed} referral asks for this job are already approved or sent (cap ${cap})` };
  }
  return null;
}

async function assertReferralLimits(db: DB, policy: OutreachPolicy, item: ReviewItemRow, now: Date): Promise<void> {
  const p = await referralLimitProblem(db, policy, item, now);
  if (p) throw new OutreachError(p.message, p.code);
}

export async function rejectReviewItem(db: DB, id: string, reason: string | null): Promise<ReviewItemRow> {
  const r = await transitionReviewItem(db, id, ['pending', 'approved'], 'rejected', { decided: true, decisionNote: reason });
  if (!r) throw new OutreachError(`review item ${id} is not pending or approved`, 'invalid_state');
  await appendEvent(db, { kind: 'review.rejected', subjectType: 'review_item', subjectId: id, payload: { reason } });
  return r;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendOutcome {
  reviewItemId: string;
  to: string;
  subject: string;
  ok: boolean;
  result?: EmailSendResult;
  error?: string;
}

export interface SendTickResult {
  mode: 'dry_run' | 'live';
  skipped?: 'locked';
  outcomes: SendOutcome[];
  held: { reviewItemId: string; reason: string }[];
  /** Live mode: the next send isn't allowed before this time (spacing). */
  waitingUntil?: Date;
  /** Live mode: the 24h cap is used up. */
  dailyCapReached?: boolean;
  sentLast24h?: number;
}

/**
 * One pass of the send loop. Dry run: shows every due approved item and sends
 * nothing (items stay approved). Live: sends at most one email, honouring the
 * daily cap, the per-company cap, and randomized spacing between sends.
 */
export async function runSendTick(deps: OutreachDeps): Promise<SendTickResult> {
  const now = deps.now?.() ?? new Date();
  const mode = deps.dryRun ? 'dry_run' : 'live';
  const out: SendTickResult = { mode, outcomes: [], held: [] };
  const owner = randomUUID();
  if (!(await tryLease(deps.db, 'outreach.send', owner, 10 * 60_000))) return { ...out, skipped: 'locked' };
  try {
    const due = await approvedDueItems(deps.db, now, 50, OUTREACH_ACTOR);
    if (deps.dryRun) {
      for (const item of due) out.outcomes.push(await executeOne(deps, item, true, now));
      return out;
    }

    requireGmail(deps.gmail);
    const nextAt = await getState<string>(deps.db, STATE_NEXT_SEND);
    if (nextAt && now < new Date(nextAt)) return { ...out, waitingUntil: new Date(nextAt) };
    out.sentLast24h = await liveSendsSince(deps.db, OUTREACH_ACTOR, new Date(now.getTime() - DAY));
    // The optional product cap (off by default) and the sender's technical limit.
    const limit = Math.min(deps.policy.dailyCap ?? Infinity, deps.policy.senderDailyLimit);
    if (out.sentLast24h >= limit) return { ...out, dailyCapReached: true };

    for (const item of due) {
      if (item.contactId) {
        const c = await getContact(deps.db, item.contactId);
        if (!c || c.status !== 'active') {
          await transitionReviewItem(deps.db, item.id, ['approved'], 'failed', { error: `contact is ${c?.status ?? 'missing'}` });
          continue;
        }
      }
      const limitProblem = await referralLimitProblem(deps.db, deps.policy, item, now);
      if (limitProblem) {
        // The rule changed under an approved item (e.g. someone else's ask went first): never send.
        await transitionReviewItem(deps.db, item.id, ['approved'], 'failed', { error: `${limitProblem.code}: ${limitProblem.message}` });
        out.held.push({ reviewItemId: item.id, reason: limitProblem.message });
        continue;
      }
      const cap = await checkCompanyCap(deps.db, item, deps.policy, now);
      if (!cap.ok) {
        const reason = `held: ${cap.emailedThisWeek}/${cap.limit} people at this company emailed in the last 7 days`;
        await transitionReviewItem(deps.db, item.id, ['approved'], 'approved', { error: reason });
        out.held.push({ reviewItemId: item.id, reason });
        continue;
      }
      // Re-read right before sending: the user may have rejected or cancelled since the query.
      const fresh = await getReviewItem(deps.db, item.id);
      if (fresh?.status !== 'approved') continue;
      const outcome = await executeOne(deps, fresh, false, now);
      out.outcomes.push(outcome);
      if (outcome.ok) {
        const [lo, hi] = deps.policy.spacingMinutes;
        const gap = (lo + (deps.random?.() ?? Math.random()) * (hi - lo)) * 60_000;
        await setState(deps.db, STATE_NEXT_SEND, new Date(now.getTime() + gap).toISOString());
        out.sentLast24h++;
      }
      break; // at most one real send per tick
    }
    return out;
  } finally {
    await releaseLease(deps.db, 'outreach.send', owner);
  }
}

async function executeOne(deps: OutreachDeps, item: ReviewItemRow, dryRun: boolean, now: Date): Promise<SendOutcome> {
  const { db } = deps;
  const approved = approvedDraftFrom(item);
  const base = { reviewItemId: item.id, to: approved.draft.to, subject: approved.draft.subject };
  const key = dryRun ? `dry:${item.id}:${now.getTime()}:${randomUUID()}` : `send:${item.id}`;
  const claim = await claimAction(db, { reviewItemId: item.id, pluginId: item.pluginId, idempotencyKey: key, dryRun });
  if (claim.existing) {
    if (claim.action.status === 'succeeded') {
      // Sent before, but we crashed before recording it: finish the bookkeeping, never resend.
      const result = claim.action.result as EmailSendResult;
      await finalizeSent(deps, item, result, claim.action.executedAt ?? now);
      return { ...base, ok: true, result };
    }
    await restartAction(db, claim.action.id);
  }

  const actor = deps.registry.actor(item.pluginId);
  const log = deps.log.child({ plugin: item.pluginId, reviewItemId: item.id });
  const ctx = buildContext(actor, { ...deps, dryRun, log, signal: AbortSignal.timeout(2 * 60_000) });
  if (!isCoreApproved(approved)) throw new Error('refusing to execute a draft the core did not approve');
  try {
    const result = (await actor.plugin.execute(ctx, approved, key)) as EmailSendResult;
    await finishAction(db, claim.action.id, { status: 'succeeded', result, at: now });
    if (dryRun) {
      await appendEvent(db, { kind: 'outreach.dry_run', subjectType: 'review_item', subjectId: item.id, payload: { to: base.to, subject: base.subject } });
    } else {
      await finalizeSent(deps, item, result, now);
    }
    return { ...base, ok: true, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await finishAction(db, claim.action.id, { status: 'failed', error, at: now });
    if (!dryRun) {
      await appendEvent(db, { kind: 'outreach.send.failed', subjectType: 'review_item', subjectId: item.id, payload: { error } });
      const attempts = await countEvents(db, 'outreach.send.failed', item.id);
      const final = attempts >= MAX_SEND_ATTEMPTS;
      await transitionReviewItem(db, item.id, ['approved'], final ? 'failed' : 'approved', {
        error: final ? `gave up after ${attempts} attempts: ${error}` : `attempt ${attempts} failed: ${error}`,
      });
    }
    log.warn({ err: error }, 'send failed');
    return { ...base, ok: false, error };
  }
}

/** Record a real send: item executed, thread created or advanced, follow-up scheduled. Safe to repeat. */
/** `sentAt` is the core's clock (what caps and follow-up timing are measured against). */
async function finalizeSent(deps: OutreachDeps, item: ReviewItemRow, r: EmailSendResult, sentAt: Date): Promise<void> {
  const { db, policy } = deps;
  const done = await transitionReviewItem(db, item.id, ['approved'], 'executed', { error: null });
  if (!done) return; // already recorded
  const followupAt = (n: number) =>
    n < Math.min(policy.maxFollowups, policy.followupDays.length) ? new Date(sentAt.getTime() + policy.followupDays[n]! * DAY) : null;
  let threadId: string | null = item.threadId;
  if (item.kind === 'outreach' || item.kind === 'referral_ask') {
    const t = await createThread(db, {
      contactId: item.contactId!,
      companyId: item.companyId,
      jobId: item.jobId,
      reviewItemId: item.id,
      gmailThreadId: r.gmailThreadId!,
      subject: (item.draft as EmailDraft).subject,
      messageId: r.messageId,
      sentAt,
      nextFollowupAt: followupAt(0),
    });
    threadId = t.id;
    if (item.batchId) await noteBatchSent(db, item.batchId, sentAt);
  } else if (item.threadId) {
    const t = await getThread(db, item.threadId);
    if (t) await recordFollowupSent(db, t.id, r.messageId, sentAt, followupAt(t.followupsSent + 1));
  }
  await appendEvent(db, {
    kind: 'outreach.sent',
    subjectType: 'review_item',
    subjectId: item.id,
    payload: { kind: item.kind, to: (item.draft as EmailDraft).to, threadId, gmailId: r.gmailId, deduplicated: r.deduplicated },
  });
}

/** A referral ask went out: bump the batch counts and move it to sending/sent. */
export async function noteBatchSent(db: DB, batchId: string, at: Date): Promise<void> {
  const b = await refreshBatchCounts(db, batchId);
  if (!b || b.status === 'replied' || b.status === 'closed') return;
  const pendingLeft = b.draftedCount - b.sentCount;
  await updateBatch(db, batchId, {
    status: pendingLeft > 0 ? 'sending' : 'sent',
    ...(b.firstSentAt ? {} : { firstSentAt: at }),
  });
}

// ---------------------------------------------------------------------------
// Follow-ups and reply tracking
// ---------------------------------------------------------------------------

/** Draft follow-ups (as pending review items) for threads whose follow-up time has come. */
export async function draftDueFollowups(deps: OutreachDeps): Promise<{ drafted: number; errors: string[] }> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const due = await threadsDueForFollowup(db, now, deps.policy.maxFollowups);
  const res = { drafted: 0, errors: [] as string[] };
  const profile = due.length ? await getActiveProfile(db) : null;
  for (const t of due) {
    try {
      if (!profile) throw new OutreachError('no profile loaded', 'no_profile');
      const contact = await getContact(db, t.contactId);
      if (!contact?.email || contact.status !== 'active') {
        await markThread(db, t.id, 'closed', now);
        continue;
      }
      const company = (await loadCompanyRef(db, contact.companyId))!;
      const job = t.jobId ? await loadJob(db, t.jobId).catch(() => null) : null;
      const [last] = await executedItemsForThread(db, t.id, t.reviewItemId);
      const input: OutreachActionInput = {
        kind: 'followup',
        job,
        company,
        contact: { ...company.contacts.find((c) => c.id === contact.id)!, email: contact.email },
        profile,
        previous: {
          subject: t.subject,
          body: (last?.draft as EmailDraft | undefined)?.body ?? '',
          sentAt: t.lastSentAt,
          followupNumber: t.followupsSent + 1,
          gmailThreadId: t.gmailThreadId,
          messageIds: t.messageIds,
        },
      };
      const draft = await prepare(deps, OUTREACH_ACTOR, input);
      const item = await createReviewItem(db, {
        kind: 'followup',
        pluginId: OUTREACH_ACTOR,
        jobId: t.jobId,
        contactId: t.contactId,
        companyId: t.companyId,
        threadId: t.id,
        draft,
      });
      await appendEvent(db, { kind: 'review.created', subjectType: 'review_item', subjectId: item.id, payload: { kind: 'followup', threadId: t.id } });
      res.drafted++;
    } catch (err) {
      res.errors.push(`${t.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return res;
}

export interface TrackSummary {
  inspected: number;
  replies: number;
  bounces: number;
}

/**
 * Poll the tracker and apply what it finds to our threads: a reply or bounce
 * closes the thread and cancels queued follow-ups; a bounce marks the contact.
 */
export async function pollTracker(deps: OutreachDeps, opts: { pluginId?: string; since?: Date } = {}): Promise<TrackSummary> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  requireGmail(deps.gmail);
  const tracker = deps.registry.tracker(opts.pluginId ?? GMAIL_TRACKER);
  const cursor = await getState<string>(db, STATE_TRACKER_CURSOR);
  // Overlap by an hour: Gmail's after: is coarse, and re-seeing a message is harmless.
  const since = opts.since ?? (cursor ? new Date(new Date(cursor).getTime() - 3600_000) : new Date(now.getTime() - 30 * DAY));
  const log = deps.log.child({ plugin: tracker.manifest.id });
  const ctx = buildContext(tracker, { ...deps, log, signal: AbortSignal.timeout(5 * 60_000) });

  const events: GmailTrackEvent[] = [];
  for await (const e of tracker.plugin.poll(ctx, since)) events.push(e as GmailTrackEvent);
  const threads = new Map((await threadsByGmailIds(db, [...new Set(events.map((e) => e.data.gmailThreadId))])).map((t) => [t.gmailThreadId, t]));

  const res: TrackSummary = { inspected: events.length, replies: 0, bounces: 0 };
  for (const e of events) {
    let thread: ThreadRow | null = threads.get(e.data.gmailThreadId) ?? null;
    const failed = (e.data as { failedRecipients?: string }).failedRecipients;
    if (!thread && e.kind === 'bounce' && failed) thread = await latestSentThreadToEmail(db, failed.split(',')[0]!.trim());
    if (!thread) continue;
    const changed = await markThread(db, thread.id, e.kind === 'reply' ? 'replied' : 'bounced', e.at);
    if (!changed) continue;
    const cancelled = await cancelPendingFollowups(db, thread.id, `cancelled: ${e.kind}`);
    if (e.kind === 'reply') {
      await confirmContactEmail(db, thread.contactId);
      res.replies++;
      await onThreadReplied(db, thread.id, e.at);
    } else {
      await setContactStatus(db, thread.contactId, 'bounced');
      res.bounces++;
    }
    await appendEvent(db, {
      kind: e.kind === 'reply' ? 'outreach.replied' : 'outreach.bounced',
      subjectType: 'outreach_thread',
      subjectId: thread.id,
      payload: { from: e.data.from, subject: e.data.subject, snippet: e.data.snippet, cancelledFollowups: cancelled },
    });
  }
  await setState(db, STATE_TRACKER_CURSOR, now.toISOString());
  return res;
}

/**
 * A reply on a referral thread (email or LinkedIn): the whole batch is
 * `replied`, its other threads stop getting follow-ups, and the autopilot
 * sequencer is told via a `referral.replied` event. Other batches are untouched.
 */
export async function onThreadReplied(db: DB, threadId: string, at: Date): Promise<void> {
  const batchId = await batchIdForThread(db, threadId);
  if (!batchId) return;
  const r = await markBatchReplied(db, batchId, at);
  const b = await refreshBatchCounts(db, batchId);
  await appendEvent(db, {
    kind: 'referral.replied',
    subjectType: 'job',
    ...(b ? { subjectId: b.jobId } : {}),
    payload: { batchId, threadId, firstReply: r.first, cancelledFollowups: r.cancelledFollowups },
  });
}

/**
 * Pick the latest successfully-rendered resume variant for a job and build an
 * EmailAttachment the actor can send. The variant must still exist on disk;
 * stale rows just produce an empty list (the user can retailor).
 */
export async function resolveResumeAttachment(db: DB, jobId: string): Promise<EmailAttachment[]> {
  const v = await latestRenderedResumeForJob(db, jobId);
  if (!v || !v.pdfPath) return [];
  return [
    {
      filename: 'resume.pdf',
      contentType: 'application/pdf',
      path: v.pdfPath,
      resumeVariantId: v.id,
    },
  ];
}
