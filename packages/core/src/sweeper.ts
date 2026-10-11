import { randomUUID } from 'node:crypto';
import { appendEvent, getPipelineState, getState, releaseLease, setState, sourcesDueForFetch, tryLease, type DB } from '@jobforge/db';
import type { AppConfig, Logger } from '@jobforge/shared';
import { runApplyTick, type ApplyDeps } from './apply.js';
import { expireDeadlines, runDeadlines, type DeadlineDeps } from './deadline-runner.js';
import { draftDueFollowups, pollTracker, type OutreachDeps } from './outreach.js';
import { advancePipelineJob, autoApproveFollowups, runSequencer, type SequencerDeps } from './sequencer.js';
import type { StageEvent } from './triggers.js';

// Phase 18 sweeper: one idempotent pass, run on server start and hourly. It
// re-derives every piece of due work from DB state, so after downtime (or a
// lost trigger) a single pass catches up without duplicating anything: each
// step is itself guarded (leases, state-guarded transitions, "already queued"
// checks). Free steps always run; LLM-spending steps only with
// autopilot.enabled; sends and applications only in live mode.

const HOUR = 3_600_000;
const FETCH_QUEUED = 'sweeper.fetchQueuedAt';

export interface SweepDeps {
  db: DB;
  log: Logger;
  config: AppConfig;
  /** MODE=live: the apply tick may submit. */
  live: boolean;
  gmailConnected: boolean;
  now?: () => Date;
  /** Queue board fetches (pg-boss); absent → the fetch step is skipped. */
  enqueueFetch?: (companySourceIds: string[]) => Promise<unknown>;
  /** Job-alert emails (Gmail). */
  alerts?: () => Promise<unknown>;
  outreach?: () => Promise<OutreachDeps>;
  /** Embed pending jobs and LLM-match them (optionally only these jobs). */
  match?: (jobIds?: string[]) => Promise<unknown>;
  sequencer?: () => Promise<SequencerDeps>;
  /** strategy = single_email: the Phase 4.5 loop instead of the sequencer. */
  singleEmail?: () => Promise<unknown>;
  deadlines?: () => Promise<DeadlineDeps>;
  apply?: () => Promise<ApplyDeps>;
}

export interface SweepStep {
  name: string;
  ok: boolean;
  skipped?: string;
  ms: number;
  result?: unknown;
  error?: string;
}

export interface SweepResult {
  skipped?: string;
  steps: SweepStep[];
}

export async function runSweep(deps: SweepDeps, opts: { reason?: string } = {}): Promise<SweepResult> {
  const owner = randomUUID();
  if (!(await tryLease(deps.db, 'sweeper', owner, 2 * HOUR))) return { skipped: 'another sweep is running', steps: [] };
  const steps: SweepStep[] = [];
  const now = () => deps.now?.() ?? new Date();
  const auto = deps.config.autopilot.enabled;
  const run = async (name: string, skip: string | null, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    if (skip) {
      steps.push({ name, ok: true, skipped: skip, ms: 0 });
      return;
    }
    try {
      steps.push({ name, ok: true, ms: 0, result: await fn() });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      steps.push({ name, ok: false, ms: 0, error });
      deps.log.warn({ step: name, err: error }, 'sweeper step failed');
    }
    steps.at(-1)!.ms = Date.now() - t0;
  };
  const noAuto = auto ? null : 'autopilot.enabled is false (LLM steps off)';
  try {
    // --- free: always ---------------------------------------------------------
    await run('fetch', deps.enqueueFetch ? null : 'no queue', async () => {
      const cutoff = new Date(now().getTime() - deps.config.sweeper.fetchEveryHours * HOUR);
      // Boards queued by an earlier sweep within the interval are left alone (the worker may be behind).
      const queued = (await getState<Record<string, string>>(deps.db, FETCH_QUEUED)) ?? {};
      const due = (await sourcesDueForFetch(deps.db, cutoff)).filter((id) => !queued[id] || new Date(queued[id]) < cutoff);
      if (due.length) await deps.enqueueFetch!(due);
      const at = now().toISOString();
      const kept = Object.fromEntries(Object.entries(queued).filter(([, t]) => new Date(t) >= cutoff));
      for (const id of due) kept[id] = at;
      await setState(deps.db, FETCH_QUEUED, kept);
      return { boards: due.length };
    });
    await run('alerts', deps.gmailConnected && deps.alerts ? null : 'Gmail not connected', () => deps.alerts!());
    await run('track', deps.gmailConnected && deps.outreach ? null : 'Gmail not connected', async () => pollTracker(await deps.outreach!()));

    // --- LLM: autopilot only ----------------------------------------------------
    await run('deadlines', null, async () => {
      if (auto && deps.deadlines) {
        const r = await runDeadlines(await deps.deadlines());
        return { estimated: r.estimated, expired: r.expired.length, failed: r.failed.length };
      }
      return { expired: (await expireDeadlines(deps.db, deps.config.deadlines, now())).length };
    });
    await run('match', noAuto ?? (deps.match ? null : 'no matcher'), () => deps.match!());
    if (deps.config.autopilot.strategy === 'single_email') {
      await run('autopilot', noAuto ?? (deps.singleEmail ? null : 'not configured'), () => deps.singleEmail!());
    } else {
      await run('sequencer', noAuto ?? (deps.sequencer ? null : 'not configured'), async () => {
        const s = await runSequencer(await deps.sequencer!());
        return { admitted: s.admitted, steps: s.steps.length, counts: s.counts, ...(s.skipped ? { skipped: s.skipped } : {}), ...(s.paused ? { paused: s.paused } : {}) };
      });
    }
    await run('followups', noAuto ?? (deps.outreach ? null : 'not configured'), async () => {
      const r = await draftDueFollowups(await deps.outreach!());
      const approved = deps.sequencer ? await autoApproveFollowups(await deps.sequencer()) : 0;
      return { ...r, autoApproved: approved };
    });

    // --- live only ----------------------------------------------------------------
    await run('apply', deps.live && deps.apply ? null : 'not live', async () => {
      const r = await runApplyTick(await deps.apply!());
      return { outcomes: r.outcomes.length, ...(r.skipped ? { skipped: r.skipped } : {}) };
    });

    await appendEvent(deps.db, {
      kind: 'sweeper.ran',
      payload: { reason: opts.reason ?? 'scheduled', steps: steps.map((s) => ({ name: s.name, ok: s.ok, skipped: s.skipped ?? null, ms: s.ms })) },
    });
  } finally {
    await releaseLease(deps.db, 'sweeper', owner);
  }
  return { steps };
}

// ---------------------------------------------------------------------------
// Stage events → work (the trigger path; the host decides how to run these)
// ---------------------------------------------------------------------------

export interface StageHandlerDeps {
  db: DB;
  log: Logger;
  /** Embed + match exactly these jobs. */
  match: (jobIds: string[]) => Promise<unknown>;
  sequencer: () => Promise<SequencerDeps>;
}

/**
 * jobs.new → match those jobs (which emits job.matched); job.matched → admit
 * each one that clears the gates and push it through resume selection and
 * fan-out; job.advance → move an in-pipeline job along (reply / deadline).
 */
export async function handleStageEvent(deps: StageHandlerDeps, e: StageEvent): Promise<void> {
  if (e.kind === 'jobs.new') {
    await deps.match(e.jobIds);
    return;
  }
  const seq = await deps.sequencer();
  const ids = e.kind === 'job.matched' ? e.jobIds : [e.jobId];
  for (const jobId of ids) {
    // A reply or a deadline only moves jobs already taken on; matching admits new ones.
    if (e.kind === 'job.advance' && !(await getPipelineState(deps.db, jobId))) continue;
    try {
      const steps = await advancePipelineJob(seq, jobId);
      if (steps.length) deps.log.info({ jobId, trigger: e.kind, steps: steps.map((s) => `${s.from ?? '∅'}→${s.to ?? '∅'}`) }, 'pipeline advanced');
    } catch (err) {
      deps.log.warn({ jobId, trigger: e.kind, err: (err as Error).message }, 'pipeline advance failed');
    }
  }
}
