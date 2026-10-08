import { randomUUID } from 'node:crypto';
import {
  canonicalProfileUrl,
  linkedinNoteDraftSchema,
  SessionBlockedError,
  type LinkedInNoteDraft,
  type LinkedInSendResult,
  type TrackEvent,
} from '@jobforge/plugin-sdk';
import {
  appendEvent,
  approvedDueItems,
  claimAction,
  countEvents,
  createThread,
  finishAction,
  getJobDetail,
  getReviewItem,
  getState,
  linkedinThreads,
  liveSendsSince,
  markThread,
  releaseLease,
  restartAction,
  setState,
  transitionReviewItem,
  tryLease,
  type ReviewItemRow,
} from '@jobforge/db';
import { buildContext } from './plugins.js';
import { linkedinPaused, pauseLinkedIn, syncLinkedInAttention, type LinkedInDeps } from './linkedin.js';
import { coreApprovedDraft, isCoreApproved, noteBatchSent, onThreadReplied, referralLimitProblem, type OutreachPolicy } from './outreach.js';
import type { RawBrowser } from './browser.js';

export const LINKEDIN_ACTOR = 'actor-linkedin-referral';
export const LINKEDIN_TRACKER = 'tracker-linkedin';
const DAY = 86_400_000;
const NEXT_ACTION = 'linkedin.nextActionAt';
const TRACK_CURSOR = 'tracker.linkedin.cursor';
const MAX_ATTEMPTS = 3;

/** A browser that refuses to open: for dry runs, which must never touch LinkedIn. */
const noBrowser: RawBrowser = {
  async newPage() {
    throw new Error('dry run: the browser is not available');
  },
};

export interface LinkedInSendDeps extends LinkedInDeps {
  policy: OutreachPolicy;
  now?: () => Date;
  random?: () => number;
}

export interface LinkedInSendTick {
  mode: 'dry_run' | 'live';
  skipped?: string;
  outcomes: { reviewItemId: string; profileUrl: string; ok: boolean; outcome?: string; error?: string }[];
  held: { reviewItemId: string; reason: string }[];
  waitingUntil?: Date;
  sentLast24h?: number;
}

/**
 * One pass of the LinkedIn send loop (PLAN Phase 9). Dry run (or LinkedIn not
 * enabled): previews due items without a browser. Live: at most one request
 * per tick, under a lease, within the account's daily connection cap, with a
 * random 45–120 s gap; a challenge page pauses everything (no retries).
 */
export async function runLinkedInSendTick(deps: LinkedInSendDeps): Promise<LinkedInSendTick> {
  const now = deps.now?.() ?? new Date();
  const live = deps.enabled && !deps.dryRun;
  const out: LinkedInSendTick = { mode: live ? 'live' : 'dry_run', outcomes: [], held: [] };
  const due = await approvedDueItems(deps.db, now, 50, LINKEDIN_ACTOR);
  if (!live) {
    for (const item of due) out.outcomes.push(await executeOne(deps, item, noBrowser, true, now));
    return out;
  }
  await syncLinkedInAttention(deps.db, deps.linkedin);
  const paused = await linkedinPaused(deps.db, deps.linkedin, now);
  if (paused) return { ...out, skipped: paused };
  const owner = randomUUID();
  if (!(await tryLease(deps.db, 'linkedin.send', owner, 15 * 60_000))) return { ...out, skipped: 'locked' };
  try {
    const nextAt = await getState<string>(deps.db, NEXT_ACTION);
    if (nextAt && now < new Date(nextAt)) return { ...out, waitingUntil: new Date(nextAt) };
    out.sentLast24h = await liveSendsSince(deps.db, LINKEDIN_ACTOR, new Date(now.getTime() - DAY));
    if (out.sentLast24h >= deps.linkedin.dailyConnectionCap) return { ...out, skipped: `daily connection cap reached (${deps.linkedin.dailyConnectionCap})` };
    for (const item of due) {
      const problem = await referralLimitProblem(deps.db, deps.policy, item, now);
      if (problem) {
        await transitionReviewItem(deps.db, item.id, ['approved'], 'failed', { error: `${problem.code}: ${problem.message}` });
        out.held.push({ reviewItemId: item.id, reason: problem.message });
        continue;
      }
      const fresh = await getReviewItem(deps.db, item.id);
      if (fresh?.status !== 'approved') continue;
      const o = await executeOne(deps, fresh, await deps.openBrowser(), false, now);
      out.outcomes.push(o);
      if (o.ok) {
        const [lo, hi] = deps.linkedin.actionGapSeconds;
        const gap = (lo + (deps.random?.() ?? Math.random()) * (hi - lo)) * 1000;
        await setState(deps.db, NEXT_ACTION, new Date(now.getTime() + gap).toISOString());
        await deps.saveSession?.().catch(() => {});
      }
      break; // one per tick
    }
    return out;
  } finally {
    await releaseLease(deps.db, 'linkedin.send', owner);
  }
}

async function executeOne(deps: LinkedInSendDeps, item: ReviewItemRow, browser: RawBrowser, dryRun: boolean, now: Date) {
  const approved = coreApprovedDraft<LinkedInNoteDraft>(item, (d) => linkedinNoteDraftSchema.parse(d));
  const base = { reviewItemId: item.id, profileUrl: approved.draft.profileUrl };
  const key = dryRun ? `dry:${item.id}:${now.getTime()}:${randomUUID()}` : `li:${item.id}`;
  const claim = await claimAction(deps.db, { reviewItemId: item.id, pluginId: LINKEDIN_ACTOR, idempotencyKey: key, dryRun });
  if (claim.existing) {
    if (claim.action.status === 'succeeded') {
      await finalize(deps, item, claim.action.result as LinkedInSendResult, claim.action.executedAt ?? now);
      return { ...base, ok: true, outcome: 'recorded' };
    }
    await restartAction(deps.db, claim.action.id);
  }
  const actor = deps.registry.actor(LINKEDIN_ACTOR);
  const log = deps.log.child({ plugin: LINKEDIN_ACTOR, reviewItemId: item.id });
  const ctx = buildContext(actor, { ...deps, browser, dryRun, log, signal: AbortSignal.timeout(5 * 60_000) });
  if (!isCoreApproved(approved)) throw new Error('refusing to execute a draft the core did not approve');
  try {
    const result = (await actor.plugin.execute(ctx, approved, key)) as LinkedInSendResult;
    await finishAction(deps.db, claim.action.id, { status: 'succeeded', result, at: now });
    if (dryRun) {
      await appendEvent(deps.db, { kind: 'linkedin.dry_run', subjectType: 'review_item', subjectId: item.id, payload: { profileUrl: base.profileUrl } });
    } else {
      await finalize(deps, item, result, now);
    }
    return { ...base, ok: true, outcome: result.outcome };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await finishAction(deps.db, claim.action.id, { status: 'failed', error, at: now });
    if (err instanceof SessionBlockedError) {
      // Pause everything and ask a human; the item stays approved and is retried only after resume.
      await pauseLinkedIn(deps.db, deps.linkedin, err, now);
      await transitionReviewItem(deps.db, item.id, ['approved'], 'approved', { error: `paused: ${err.reason}` });
      return { ...base, ok: false, error };
    }
    if (!dryRun) {
      await appendEvent(deps.db, { kind: 'linkedin.send.failed', subjectType: 'review_item', subjectId: item.id, payload: { error } });
      const attempts = await countEvents(deps.db, 'linkedin.send.failed', item.id);
      await transitionReviewItem(deps.db, item.id, ['approved'], attempts >= MAX_ATTEMPTS ? 'failed' : 'approved', {
        error: attempts >= MAX_ATTEMPTS ? `gave up after ${attempts} attempts: ${error}` : `attempt ${attempts} failed: ${error}`,
      });
    }
    log.warn({ err: error }, 'LinkedIn send failed');
    return { ...base, ok: false, error };
  }
}

async function finalize(deps: LinkedInSendDeps, item: ReviewItemRow, r: LinkedInSendResult, at: Date): Promise<void> {
  const done = await transitionReviewItem(deps.db, item.id, ['approved'], 'executed', { error: null });
  if (!done) return;
  const draft = linkedinNoteDraftSchema.parse(item.draft);
  const job = item.jobId ? await getJobDetail(deps.db, item.jobId, null) : null;
  const t = await createThread(deps.db, {
    contactId: item.contactId!,
    companyId: item.companyId,
    jobId: item.jobId,
    reviewItemId: item.id,
    gmailThreadId: `linkedin:${canonicalProfileUrl(draft.profileUrl) ?? draft.profileUrl}`,
    subject: `LinkedIn: ${job?.title ?? 'referral ask'}`,
    messageId: `linkedin:${item.id}`,
    sentAt: at,
    nextFollowupAt: null, // no follow-ups on a pending connection request
    channel: 'linkedin',
  });
  if (item.batchId) await noteBatchSent(deps.db, item.batchId, at);
  await appendEvent(deps.db, {
    kind: 'linkedin.sent',
    subjectType: 'review_item',
    subjectId: item.id,
    payload: { threadId: t.id, outcome: r.outcome, screenshots: r.screenshots },
  });
}

export interface LinkedInTrackSummary {
  skipped?: string;
  events: number;
  accepted: number;
  replies: number;
  error?: string;
}

/**
 * Poll LinkedIn (read-only) for accepted connections and replies on our
 * referral threads. Either counts as a reply: the thread is `replied`, the
 * batch stops its follow-ups, and Phase 12 sees `referral.replied`.
 */
/**
 * Inbox rows carry only a name, so a name maps to a thread only when it names one
 * contact we asked; a name shared by several contacts maps to null (never guessed),
 * so a reply from one "Rahul Sharma" can't mark another's thread.
 */
export function threadsByName<T extends { contactId: string; contactName: string }>(threads: T[]): Map<string, T | null> {
  const byName = new Map<string, T | null>();
  for (const t of threads) {
    const key = t.contactName.trim().toLowerCase();
    const prev = byName.get(key);
    byName.set(key, prev === undefined || prev?.contactId === t.contactId ? t : null);
  }
  return byName;
}

export async function pollLinkedInTracker(deps: LinkedInDeps & { now?: () => Date }): Promise<LinkedInTrackSummary> {
  const now = deps.now?.() ?? new Date();
  const res: LinkedInTrackSummary = { events: 0, accepted: 0, replies: 0 };
  if (!deps.enabled) return { ...res, skipped: 'LinkedIn is disabled (set LINKEDIN_ENABLED=true and run live)' };
  await syncLinkedInAttention(deps.db, deps.linkedin);
  const paused = await linkedinPaused(deps.db, deps.linkedin, now);
  if (paused) return { ...res, skipped: paused };
  const threads = await linkedinThreads(deps.db);
  if (!threads.length) return { ...res, skipped: 'no LinkedIn referral threads to watch' };
  const cursor = await getState<string>(deps.db, TRACK_CURSOR);
  const since = cursor ? new Date(cursor) : new Date(now.getTime() - 30 * DAY);
  const tracker = deps.registry.tracker(LINKEDIN_TRACKER);
  const ctx = buildContext(tracker, {
    ...deps,
    browser: await deps.openBrowser(),
    dryRun: false,
    log: deps.log.child({ plugin: LINKEDIN_TRACKER }),
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const byUrl = new Map(threads.filter((t) => t.linkedinUrl).map((t) => [canonicalProfileUrl(t.linkedinUrl!), t]));
  const byName = threadsByName(threads);
  try {
    for await (const e of tracker.plugin.poll(ctx, since) as AsyncIterable<TrackEvent>) {
      res.events++;
      const data = e.data as { profileUrl?: string; name?: string; snippet?: string };
      const t = (data.profileUrl ? byUrl.get(canonicalProfileUrl(data.profileUrl)) : undefined) ?? (data.name ? byName.get(data.name.trim().toLowerCase()) : undefined);
      if (!t) {
        if (t === null) deps.log.warn({ name: data.name }, 'LinkedIn reply from a name shared by several contacts; not matched');
        continue;
      }
      if (e.kind === 'accepted') res.accepted++;
      else res.replies++;
      await appendEvent(deps.db, {
        kind: e.kind === 'accepted' ? 'linkedin.accepted' : 'linkedin.replied',
        subjectType: 'outreach_thread',
        subjectId: t.threadId,
        payload: { name: data.name, snippet: data.snippet ?? null },
      });
      if (t.state === 'sent' && (await markThread(deps.db, t.threadId, 'replied', e.at))) {
        t.state = 'replied';
        await onThreadReplied(deps.db, t.threadId, e.at);
      }
    }
    await setState(deps.db, TRACK_CURSOR, now.toISOString());
    await deps.saveSession?.().catch(() => {});
  } catch (err) {
    res.error = err instanceof Error ? err.message : String(err);
    if (err instanceof SessionBlockedError) await pauseLinkedIn(deps.db, deps.linkedin, err, now);
  }
  return res;
}
