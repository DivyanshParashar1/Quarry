import { linkedinManualDraftSchema, type LinkedInManualDraft } from '@jobforge/plugin-sdk';
import {
  appendEvent,
  createThread,
  getContact,
  getReviewItem,
  listReviewItems,
  markThread,
  threadForReviewItem,
  transitionReviewItem,
  type DB,
  type ReviewItemRow,
  type ReviewListRow,
  type ThreadRow,
} from '@jobforge/db';
import { LINKEDIN_MANUAL_ACTOR, noteBatchSent, onThreadReplied, OutreachError, referralLimitProblem, type OutreachPolicy } from './outreach.js';

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
    kind: ['referral_ask', 'outreach'],
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

/**
 * "I sent it": record a manual LinkedIn message as sent. Works from pending
 * (sending it is the approval) or approved; the cooldown and per-job cap are
 * still checked, as for any ask.
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
  const problem = await referralLimitProblem(db, policy, item, at);
  if (problem) throw new OutreachError(problem.message, problem.code);
  const draft = linkedinManualDraftSchema.parse(item.draft);
  const done = await transitionReviewItem(db, item.id, ['pending', 'approved'], 'executed', {
    error: null,
    ...(item.status === 'pending' ? { decided: true, decidedBy: 'human' as const, decisionNote: 'sent by hand on LinkedIn' } : {}),
  });
  if (!done) throw new OutreachError('item changed state while marking it sent', 'invalid_state');
  const thread = await createThread(db, {
    contactId: item.contactId!,
    companyId: item.companyId,
    jobId: item.jobId,
    reviewItemId: item.id,
    gmailThreadId: `linkedin-manual:${item.id}`,
    subject: `LinkedIn ${draft.kind}: ${draft.jobTitle ?? 'referral ask'}`,
    messageId: `linkedin-manual:${item.id}`,
    sentAt: at,
    // Follow-ups are scheduled by the Phase 18 sweeper (24 h, messages only; a pending request gets none).
    nextFollowupAt: null,
    channel: 'linkedin',
  });
  if (item.batchId) await noteBatchSent(db, item.batchId, at);
  await appendEvent(db, {
    kind: 'linkedin.manual_sent',
    subjectType: 'review_item',
    subjectId: item.id,
    payload: { threadId: thread.id, kind: draft.kind, profileUrl: draft.profileUrl },
  });
  return { item: done, thread };
}

/** "They replied" (or accepted the request): the thread is replied and the referral batch stops its follow-ups. */
export async function markLinkedInReplied(db: DB, reviewItemId: string, opts: { at?: Date; note?: string } = {}): Promise<ThreadRow> {
  const at = opts.at ?? new Date();
  const item = await getReviewItem(db, reviewItemId);
  assertManual(item, reviewItemId);
  const thread = await threadForReviewItem(db, item.id);
  if (!thread) throw new OutreachError('mark it sent first', 'invalid_state');
  const updated = await markThread(db, thread.id, 'replied', at);
  if (!updated) return thread; // already replied/closed
  await appendEvent(db, { kind: 'linkedin.replied', subjectType: 'outreach_thread', subjectId: thread.id, payload: { manual: true, note: opts.note ?? null } });
  await onThreadReplied(db, thread.id, at);
  return updated;
}
