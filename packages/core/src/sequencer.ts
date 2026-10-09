import { randomUUID } from 'node:crypto';
import type { AppConfig, Logger } from '@jobforge/shared';
import {
  appendEvent,
  enterPipeline,
  getActiveProfile,
  getBatchForJob,
  getPipelineState,
  getReviewItem,
  jobsInState,
  listRankedJobs,
  listBatchItems,
  pipelineStateCounts,
  releaseLease,
  reviewCounts,
  sql,
  transitionPipeline,
  transitionReviewItem,
  tryLease,
  updatePipelineMetadata,
  type DB,
  type PipelineRow,
  type PipelineState,
  type ResumeVariantRow,
} from '@jobforge/db';
import { applicationDraftSchema } from '@jobforge/plugin-sdk';
import { loadMatchConfidence } from './autopilot.js';
import { draftApplication, type ApplyDeps } from './apply.js';
import { isDeadlineImminent } from './deadline-runner.js';
import { approveReviewItem, OutreachError, referralLimitProblem } from './outreach.js';
import { fanOutReferrals, type FanOutDeps } from './referrals.js';
import { selectResumeForJob } from './resume-library.js';
import type { TailorRunDeps } from './tailor-runner.js';

// Phase 12: referral-first, apply-on-deadline. Per job:
//   candidate         passed the match + tailor gates
//   referral_pending  N referral asks fanned out (Phase 8/9)
//     → wait until: a reply, OR referralWaitDays after the first ask, OR the deadline is near (Phase 10)
//   ready_to_apply    an application review item is queued (Phase 11), or a manual apply is flagged
//   applied | expired | failed
// Every step is guarded on the current state and every side step is itself
// idempotent (one batch per job, one application per job+profile), so a run
// killed half-way resumes on the next tick without duplicating anything.

const DAY = 86_400_000;
const NON_TERMINAL: PipelineState[] = ['candidate', 'referral_pending', 'ready_to_apply'];

export interface SequencerDeps {
  db: DB;
  log: Logger;
  policy: AppConfig['autopilot'];
  outreachPolicy: AppConfig['outreach'];
  fanOutDeps: FanOutDeps;
  tailorDeps: TailorRunDeps;
  applyDeps: ApplyDeps;
  now?: () => Date;
}

export interface SequencerStep {
  jobId: string;
  from: PipelineState | null;
  to: PipelineState | null;
  reason: string;
  note?: string;
}

export interface SequencerSummary {
  skipped?: string;
  /** Set when new admissions / fan-outs were held back this tick (review-queue backpressure). */
  paused?: string;
  admitted: number;
  steps: SequencerStep[];
  counts: Record<PipelineState, number>;
}

export async function runSequencer(deps: SequencerDeps, opts: { limit?: number } = {}): Promise<SequencerSummary> {
  const owner = randomUUID();
  const counts0 = await pipelineStateCounts(deps.db);
  if (!(await tryLease(deps.db, 'autopilot.sequence', owner, 30 * 60_000))) return { skipped: 'locked', admitted: 0, steps: [], counts: counts0 };
  const steps: SequencerStep[] = [];
  let admitted = 0;
  let paused: string | undefined;
  try {
    const now = deps.now?.() ?? new Date();
    await expireClosed(deps, steps);
    await syncApplications(deps, steps);
    await checkWaits(deps, now, steps);
    await queueApplications(deps, steps);
    paused = await backpressure(deps);
    if (paused) {
      deps.log.warn({ reason: paused }, 'sequencer: new fan-outs paused');
    } else {
      admitted = await admitCandidates(deps, opts.limit, steps);
      await fanOutCandidates(deps, steps);
    }
    await queueApplications(deps, steps); // jobs that skipped straight to ready_to_apply
    await appendEvent(deps.db, { kind: 'autopilot.sequence', payload: { admitted, steps: steps.length, ...(paused ? { paused } : {}) } });
  } finally {
    await releaseLease(deps.db, 'autopilot.sequence', owner);
  }
  return { admitted, steps, counts: await pipelineStateCounts(deps.db), ...(paused ? { paused } : {}) };
}

/** Phase 14: hold new work back while the review queue is backed up. */
async function backpressure(deps: SequencerDeps): Promise<string | undefined> {
  const max = deps.policy.maxPendingReviews;
  if (max === null) return undefined;
  const { pending } = await reviewCounts(deps.db);
  return pending >= max ? `review_queue_full (${pending} pending ≥ ${max})` : undefined;
}

async function step(deps: SequencerDeps, steps: SequencerStep[], row: PipelineRow, to: PipelineState, reason: string, meta: Record<string, unknown> = {}, note?: string): Promise<boolean> {
  const moved = await transitionPipeline(deps.db, row.jobId, [row.state], to, reason, meta, deps.now?.() ?? new Date());
  if (moved) steps.push({ jobId: row.jobId, from: row.state, to, reason, ...(note ? { note } : {}) });
  return !!moved;
}

/** Any non-terminal job whose posting closed (deadline passed, left the board) → expired. */
async function expireClosed(deps: SequencerDeps, steps: SequencerStep[]): Promise<void> {
  const rows = await deps.db.execute<{ job_id: string; state: PipelineState; reason: string | null }>(sql`
    select p.job_id, p.state, j.closed_reason as reason from job_pipeline_state p join jobs j on j.id = p.job_id
    where p.state in ('candidate', 'referral_pending', 'ready_to_apply') and j.closed_at is not null`);
  for (const r of rows) {
    // An application already in flight can still go out; only stop jobs that haven't been applied for.
    const row = (await getPipelineState(deps.db, r.job_id))!;
    const appId = (row.metadata as { applyReviewItemId?: string }).applyReviewItemId;
    if (appId && (await getReviewItem(deps.db, appId))?.status === 'approved') continue;
    await step(deps, steps, row, 'expired', r.reason === 'deadline' ? 'deadline_passed' : 'posting_closed');
  }
}

/** ready_to_apply → applied / failed / expired from the application review item's fate. */
async function syncApplications(deps: SequencerDeps, steps: SequencerStep[]): Promise<void> {
  for (const row of await jobsInState(deps.db, ['ready_to_apply'])) {
    const id = (row.metadata as { applyReviewItemId?: string }).applyReviewItemId;
    if (!id) continue;
    const item = await getReviewItem(deps.db, id);
    if (!item) continue;
    if (item.status === 'executed') await step(deps, steps, row, 'applied', 'application_submitted');
    else if (item.status === 'failed') await step(deps, steps, row, 'failed', 'application_failed', {}, item.error ?? undefined);
    else if (item.status === 'rejected' || item.status === 'cancelled') await step(deps, steps, row, 'expired', 'application_rejected_by_you', {}, item.decisionNote ?? undefined);
  }
}

/** referral_pending → ready_to_apply: a reply, the wait elapsed, or the deadline is near. */
async function checkWaits(deps: SequencerDeps, now: Date, steps: SequencerStep[]): Promise<void> {
  for (const row of await jobsInState(deps.db, ['referral_pending'])) {
    const batch = await getBatchForJob(deps.db, row.jobId);
    const [job] = await deps.db.execute<{ inferred_deadline: string | null; deadline_confidence: number | null }>(
      sql`select inferred_deadline, deadline_confidence from jobs where id = ${row.jobId}`,
    );
    const since = batch?.firstSentAt ?? row.enteredStateAt;
    let reason: string | null = null;
    if (batch?.status === 'replied') reason = 'referral_replied';
    else if (job && isDeadlineImminent({ inferredDeadline: job.inferred_deadline, deadlineConfidence: job.deadline_confidence }, now, deps.policy.deadlineImminentDays)) reason = 'deadline_imminent';
    else if (now.getTime() - since.getTime() >= deps.policy.referralWaitDays * DAY) reason = batch?.firstSentAt ? 'wait_elapsed' : 'wait_elapsed_no_ask_sent';
    if (reason) await step(deps, steps, row, 'ready_to_apply', reason, { repliedCount: batch?.repliedCount ?? 0, sentCount: batch?.sentCount ?? 0 });
  }
}

/** Queue the application review item (Phase 11), or flag a manual apply when the ATS isn't supported. */
async function queueApplications(deps: SequencerDeps, steps: SequencerStep[]): Promise<void> {
  for (const row of await jobsInState(deps.db, ['ready_to_apply'])) {
    const meta = row.metadata as { applyReviewItemId?: string; manualApply?: boolean; applyError?: string };
    if (meta.applyReviewItemId || meta.manualApply) continue;
    try {
      const item = await draftApplication(deps.applyDeps, row.jobId);
      await updatePipelineMetadata(deps.db, row.jobId, { applyReviewItemId: item.id, applyError: null });
      const draft = applicationDraftSchema.parse(item.draft);
      if (deps.policy.autoApproveApplications && !draft.missingRequired.length) {
        await approveReviewItem(deps.db, deps.outreachPolicy, item.id, { note: 'autopilot' });
        await transitionReviewItem(deps.db, item.id, ['approved'], 'approved', { decidedBy: 'autopilot' });
      }
      steps.push({ jobId: row.jobId, from: 'ready_to_apply', to: 'ready_to_apply', reason: 'application_queued', ...(draft.missingRequired.length ? { note: `needs: ${draft.missingRequired.join(', ')}` } : {}) });
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof OutreachError && err.code === 'duplicate') continue;
      const manual = /supports Greenhouse, Lever and Ashby/.test(msg);
      if (meta.applyError === msg) continue; // already recorded; don't spam events
      await updatePipelineMetadata(deps.db, row.jobId, manual ? { manualApply: true, applyError: msg } : { applyError: msg });
      steps.push({ jobId: row.jobId, from: 'ready_to_apply', to: 'ready_to_apply', reason: manual ? 'manual_apply_needed' : 'application_blocked', note: msg });
    }
  }
}

/** Take on new top-ranked jobs that pass the match + tailor gates, up to maxConcurrentJobs in flight. */
async function admitCandidates(deps: SequencerDeps, limit: number | undefined, steps: SequencerStep[]): Promise<number> {
  const { policy, db } = deps;
  const counts = await pipelineStateCounts(db);
  const room = policy.maxConcurrentJobs - counts.candidate - counts.referral_pending;
  if (room <= 0) return 0;
  const profile = await getActiveProfile(db);
  if (!profile) return 0;
  const ranked = await listRankedJobs(db, { profileVersion: profile.version, methods: ['llm'], minScore: policy.minMatchScore, sort: 'score', limit: Math.min(limit ?? policy.candidateBatch, 100) + 50 });
  let admitted = 0;
  for (const job of ranked.rows) {
    if (admitted >= Math.min(room, limit ?? policy.candidateBatch)) break;
    if (await getPipelineState(db, job.id)) continue;
    const matchConfidence = await loadMatchConfidence(db, job.id, profile.version);
    if (matchConfidence !== null && matchConfidence < policy.confidenceFloor.match) continue;
    // Phase 16: the selector picks a library resume (+ per-job skills rewrite), re-using an earlier decision.
    let variant: ResumeVariantRow;
    try {
      variant = (await selectResumeForJob(deps.tailorDeps, job.id)).variant;
    } catch (err) {
      deps.log.warn({ jobId: job.id, err: (err as Error).message }, 'sequencer: resume selection failed');
      continue;
    }
    if (variant.status !== 'rendered' || (variant.confidence ?? 0) < policy.confidenceFloor.tailor) continue;
    if (await enterPipeline(db, job.id, { matchScore: job.score, matchConfidence, tailorConfidence: variant.confidence, resumeVariantId: variant.id })) {
      admitted++;
      steps.push({ jobId: job.id, from: null, to: 'candidate', reason: 'passed_gates' });
    }
  }
  return admitted;
}

/** candidate → referral_pending: fan out N asks and auto-approve the confident ones. */
async function fanOutCandidates(deps: SequencerDeps, steps: SequencerStep[]): Promise<void> {
  const { policy, db } = deps;
  for (const row of await jobsInState(db, ['candidate'])) {
    try {
      const r = await fanOutReferrals(deps.fanOutDeps, row.jobId, { count: policy.referralsPerJob ?? deps.outreachPolicy.perJobReferralCap });
      const items = await listBatchItems(db, r.batch.id);
      const live = items.filter((i) => !['rejected', 'cancelled', 'failed'].includes(i.status));
      if (!live.length) {
        await step(deps, steps, row, 'ready_to_apply', 'no_referral_contacts', { skipped: r.skipped.length });
        continue;
      }
      const approved = policy.autoApproveReferrals ? await autoApproveAsks(deps, live.filter((i) => i.status === 'pending').map((i) => i.id)) : 0;
      await step(deps, steps, row, 'referral_pending', 'fanned_out', { batchId: r.batch.id, asks: live.length, autoApproved: approved, shortBy: r.shortBy });
    } catch (err) {
      deps.log.warn({ jobId: row.jobId, err: (err as Error).message }, 'sequencer: fan-out failed');
      if (err instanceof OutreachError && err.code === 'job_closed') await step(deps, steps, row, 'expired', 'posting_closed');
    }
  }
}

async function autoApproveAsks(deps: SequencerDeps, ids: string[]): Promise<number> {
  const { db, policy } = deps;
  const [used] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from review_items where decided_by = 'autopilot' and kind = 'referral_ask'
      and decided_at >= now() - interval '24 hours'`);
  let budget = policy.maxAutoApprovedAsksPerDay - (used?.n ?? 0);
  let approved = 0;
  for (const id of ids) {
    if (budget <= 0) break;
    const item = await getReviewItem(db, id);
    const conf = (item?.draft as { confidence?: number | null } | undefined)?.confidence ?? 0;
    if (!item || item.status !== 'pending' || conf < policy.confidenceFloor.outreach) continue; // low confidence → human review
    if (await referralLimitProblem(db, deps.outreachPolicy, item, deps.now?.() ?? new Date())) continue;
    const ok = await transitionReviewItem(db, id, ['pending'], 'approved', { decided: true, decidedBy: 'autopilot', confidence: conf, decisionNote: `autopilot: ask confidence ${conf.toFixed(2)}` });
    if (ok) {
      approved++;
      budget--;
      await appendEvent(db, { kind: 'autopilot.approved', subjectType: 'review_item', subjectId: id, payload: { kind: 'referral_ask', confidence: conf } });
    }
  }
  return approved;
}

// ---------------------------------------------------------------------------
// Manual overrides (MCP advance_job / expire_job, dashboard)
// ---------------------------------------------------------------------------

/** Push a job one step: none→candidate, candidate→fan out, referral_pending→ready_to_apply, ready_to_apply→applied (applied by hand). */
export async function advanceJob(deps: SequencerDeps, jobId: string): Promise<PipelineRow> {
  const row = await getPipelineState(deps.db, jobId);
  const steps: SequencerStep[] = [];
  if (!row) {
    await enterPipeline(deps.db, jobId, { manual: true });
  } else if (row.state === 'candidate') {
    const before = row.state;
    await fanOutCandidatesFor(deps, row, steps);
    if ((await getPipelineState(deps.db, jobId))!.state === before) throw new OutreachError('fan-out did not move the job; see the server log', 'invalid_state');
  } else if (row.state === 'referral_pending') {
    await transitionPipeline(deps.db, jobId, ['referral_pending'], 'ready_to_apply', 'manual_advance');
    await queueApplications(deps, steps);
  } else if (row.state === 'ready_to_apply') {
    await transitionPipeline(deps.db, jobId, ['ready_to_apply'], 'applied', 'applied_manually');
  } else {
    throw new OutreachError(`job is already ${row.state}`, 'invalid_state');
  }
  return (await getPipelineState(deps.db, jobId))!;
}

async function fanOutCandidatesFor(deps: SequencerDeps, row: PipelineRow, steps: SequencerStep[]): Promise<void> {
  // Same path as the tick, restricted to this job.
  const { policy, db } = deps;
  const r = await fanOutReferrals(deps.fanOutDeps, row.jobId, { count: policy.referralsPerJob ?? deps.outreachPolicy.perJobReferralCap });
  const live = (await listBatchItems(db, r.batch.id)).filter((i) => !['rejected', 'cancelled', 'failed'].includes(i.status));
  if (!live.length) await step(deps, steps, row, 'ready_to_apply', 'no_referral_contacts');
  else await step(deps, steps, row, 'referral_pending', 'fanned_out_manually', { batchId: r.batch.id, asks: live.length });
}

/** Give up on a job (any non-terminal state) with a reason. */
export async function expireJob(db: DB, jobId: string, reason: string): Promise<PipelineRow> {
  const moved = await transitionPipeline(db, jobId, NON_TERMINAL, 'expired', reason || 'expired_manually');
  if (moved) return moved;
  const cur = await getPipelineState(db, jobId);
  if (!cur) {
    await enterPipeline(db, jobId, { manual: true });
    return (await transitionPipeline(db, jobId, ['candidate'], 'expired', reason || 'expired_manually'))!;
  }
  throw new OutreachError(`job is already ${cur.state}`, 'invalid_state');
}
