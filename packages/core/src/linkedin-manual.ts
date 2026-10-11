import { linkedinManualDraftSchema, type LinkedInManualDraft } from '@quarry/plugin-sdk';
import {
  appendEvent,
  createReviewItem,
  createThread,
  getActiveProfile,
  getContact,
  getReviewItem,
  getThread,
  listReviewItems,
  markThread,
  recordFollowupSent,
  recordThreadMessage,
  setContactImportFields,
  threadForReviewItem,
  transitionReviewItem,
  type DB,
  type ReviewItemRow,
  type ReviewListRow,
  type ThreadRow,
} from '@quarry/db';
import { loadCompanyRef } from './contacts-runner.js';
import {
  LINKEDIN_MANUAL_ACTOR,
  loadJobForOutreach,
  noteBatchSent,
  onThreadReplied,
  OutreachError,
  prepareDraft,
  referralLimitProblem,
  resolveResumeAttachment,
  type OutreachDeps,
  type OutreachPolicy,
} from './outreach.js';
import { resumeBulletsForJob } from './referrals.js';

// Phase 17: LinkedIn referral messages are sent by the user, by hand. The system
// drafts them (actor-linkedin-manual); the user copies one into LinkedIn and marks
// it sent here, which records it exactly like an automated send (thread, batch
// counts, cooldown), so follow-ups and the apply trigger keep working.

export interface LinkedInDraftRow extends ReviewListRow {
  linkedin: LinkedInManualDraft;
}

/** Manual LinkedIn drafts still to send (pending review or approved), newest first. */
export async function listLinkedInDrafts(db: DB, f: { jobId?: string; includeSent?: boolean } = {}): Promise<LinkedInDraftRow[]> {
  const items = await listReviewItems(db, {
    status: f.includeSent ? ['pending', 'approved', 'executed'] : ['pending', 'approved'],
    kind: ['referral_ask', 'outreach', 'followup'],
    limit: 500,
  });
  return items
    .filter((i) => i.pluginId === LINKEDIN_MANUAL_ACTOR && (!f.jobId || i.jobId === f.jobId))
    .map((i) => ({ ...i, linkedin: linkedinManualDraftSchema.parse(i.draft) }));
}

function assertManual(item: ReviewItemRow | null, id: string): asserts item is ReviewItemRow {
  if (!item) throw new OutreachError(`review item ${id} not found`, 'not_found');
  if (item.pluginId !== LINKEDIN_MANUAL_ACTOR) throw new OutreachError('only manual LinkedIn drafts are marked sent by hand', 'invalid_state');
}

/** When the next (and, by default, only) follow-up of a thread is due; null = none left. */
export function followupDueAt(policy: OutreachPolicy, sentAt: Date, followupsSent: number): Date | null {
  return followupsSent < Math.min(policy.maxFollowups, policy.followupDays.length)
    ? new Date(sentAt.getTime() + policy.followupDays[followupsSent]! * 86_400_000)
    : null;
}

/**
 * "I sent it": record a manual LinkedIn draft as sent. Works from pending
 * (sending it is the approval) or approved. A first ask opens a thread (the
 * cooldown and per-job cap are checked as for any ask); a message gets the 24 h
 * follow-up, a connection note none. An after-accept message or a follow-up goes
 * on the existing thread.
 */
export async function markLinkedInSent(
  db: DB,
  policy: OutreachPolicy,
  reviewItemId: string,
  opts: { at?: Date } = {},
): Promise<{ item: ReviewItemRow; thread: ThreadRow }> {
  const at = opts.at ?? new Date();
  const item = await getReviewItem(db, reviewItemId);
  assertManual(item, reviewItemId);
  if (item.status === 'executed') throw new OutreachError('already marked sent', 'invalid_state');
  if (item.status !== 'pending' && item.status !== 'approved') throw new OutreachError(`item is ${item.status}`, 'invalid_state');
  if (item.contactId) {
    const c = await getContact(db, item.contactId);
    if (!c || c.status !== 'active') throw new OutreachError(`contact is ${c?.status ?? 'missing'}`, 'contact_inactive');
  }
  const draft = linkedinManualDraftSchema.parse(item.draft);
  const onThread = item.threadId ? await getThread(db, item.threadId) : null;
  if (item.kind === 'followup' && !onThread) throw new OutreachError('the thread this follow-up belongs to is gone', 'invalid_state');
  if (onThread && onThread.state !== 'sent') throw new OutreachError(`the conversation is already ${onThread.state}`, 'invalid_state');
  if (!onThread) {
    const problem = await referralLimitProblem(db, policy, item, at);
    if (problem) throw new OutreachError(problem.message, problem.code);
  }
  const done = await transitionReviewItem(db, item.id, ['pending', 'approved'], 'executed', {
    error: null,
    ...(item.status === 'pending' ? { decided: true, decidedBy: 'human' as const, decisionNote: 'sent by hand on LinkedIn' } : {}),
  });
  if (!done) throw new OutreachError('item changed state while marking it sent', 'invalid_state');

  let thread: ThreadRow;
  const messageId = `linkedin-manual:${item.id}`;
  if (onThread) {
    if (draft.purpose === 'followup') {
      await recordFollowupSent(db, onThread.id, messageId, at, followupDueAt(policy, at, onThread.followupsSent + 1));
    } else {
      // after_accept: the real referral message; its 24 h follow-up starts now.
      await recordThreadMessage(db, onThread.id, messageId, at, followupDueAt(policy, at, onThread.followupsSent));
    }
    thread = (await getThread(db, onThread.id))!;
  } else {
    thread = await createThread(db, {
      contactId: item.contactId!,
      companyId: item.companyId,
      jobId: item.jobId,
      reviewItemId: item.id,
      gmailThreadId: messageId,
      subject: `LinkedIn ${draft.kind}: ${draft.jobTitle ?? 'referral ask'}`,
      messageId,
      sentAt: at,
      // A pending connection request gets no reminder; a message gets the 24 h follow-up.
      nextFollowupAt: draft.kind === 'message' ? followupDueAt(policy, at, 0) : null,
      channel: 'linkedin',
    });
    if (item.batchId) await noteBatchSent(db, item.batchId, at);
  }
  await appendEvent(db, {
    kind: 'linkedin.manual_sent',
    subjectType: 'review_item',
    subjectId: item.id,
    payload: { threadId: thread.id, kind: draft.kind, purpose: draft.purpose, profileUrl: draft.profileUrl },
  });
  return { item: done, thread };
}

/**
 * "They accepted" (on a sent connection note): they are now a connection, so
 * draft the full referral message (with the resume) on the same thread, for the
 * user to send. Approval follows the same gate as asks (the caller decides).
 */
export async function markLinkedInAccepted(deps: OutreachDeps, reviewItemId: string, opts: { at?: Date } = {}): Promise<ReviewItemRow> {
  const { db } = deps;
  const at = opts.at ?? new Date();
  const item = await getReviewItem(db, reviewItemId);
  assertManual(item, reviewItemId);
  const draft = linkedinManualDraftSchema.parse(item.draft);
  if (draft.kind !== 'note' || item.status !== 'executed') throw new OutreachError('only a sent connection note can be accepted', 'invalid_state');
  const thread = await threadForReviewItem(db, item.id);
  if (!thread || thread.state !== 'sent') throw new OutreachError(`the conversation is ${thread?.state ?? 'missing'}`, 'invalid_state');
  const existing = (await listReviewItems(db, { status: ['pending', 'approved', 'executed'], kind: ['followup'], limit: 500 })).find(
    (i) => i.threadId === thread.id && i.pluginId === LINKEDIN_MANUAL_ACTOR,
  );
  if (existing) return existing;
  if (item.contactId) await setContactImportFields(db, item.contactId, { linkedinDegree: 1 });
  if (!item.jobId || !item.contactId) throw new OutreachError('the note has no job or contact', 'invalid_state');

  const job = await loadJobForOutreach(db, item.jobId);
  const company = (await loadCompanyRef(db, item.companyId ?? job.companyId))!;
  const profile = await getActiveProfile(db);
  if (!profile) throw new OutreachError('no profile loaded', 'no_profile');
  const ref = company.contacts.find((c) => c.id === item.contactId)!;
  const message = linkedinManualDraftSchema.parse({
    ...(await prepareDraft(deps, LINKEDIN_MANUAL_ACTOR, {
      kind: 'referral_ask',
      job,
      company,
      contact: { ...ref, linkedinDegree: 1, email: '' },
      profile,
      resumeBullets: await resumeBulletsForJob(db, item.jobId),
      attachments: await resolveResumeAttachment(db, item.jobId),
    })),
    purpose: 'after_accept',
  });
  const followup = await createReviewItem(db, {
    kind: 'followup',
    pluginId: LINKEDIN_MANUAL_ACTOR,
    jobId: item.jobId,
    contactId: item.contactId,
    companyId: item.companyId,
    threadId: thread.id,
    draft: message,
  });
  await appendEvent(db, { kind: 'linkedin.accepted', subjectType: 'outreach_thread', subjectId: thread.id, payload: { manual: true, at: at.toISOString(), messageItemId: followup.id } });
  return followup;
}

/** "They replied" (or accepted the request): the thread is replied and the referral batch stops its follow-ups. */
export async function markLinkedInReplied(db: DB, reviewItemId: string, opts: { at?: Date; note?: string } = {}): Promise<ThreadRow> {
  const at = opts.at ?? new Date();
  const item = await getReviewItem(db, reviewItemId);
  assertManual(item, reviewItemId);
  const thread = item.threadId ? await getThread(db, item.threadId) : await threadForReviewItem(db, item.id);
  if (!thread) throw new OutreachError('mark it sent first', 'invalid_state');
  const updated = await markThread(db, thread.id, 'replied', at);
  if (!updated) return thread; // already replied/closed
  await appendEvent(db, { kind: 'linkedin.replied', subjectType: 'outreach_thread', subjectId: thread.id, payload: { manual: true, note: opts.note ?? null } });
  await onThreadReplied(db, thread.id, at);
  return updated;
}
