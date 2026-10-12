import { applicationDraftSchema } from '@quarry/plugin-sdk';
import { jobsInState, listReviewItems } from '@quarry/db';
import { runApplyTick, type ApplyTickResult } from './apply.js';
import { approveReviewItem } from './outreach.js';
import { runSequencer, type SequencerDeps } from './sequencer.js';

// "Apply all" (dashboard): one pass of the sequencer (drafts an application for
// every ready job on a supported ATS), approve every pending application whose
// required questions are answered, then submit the approved ones back to back
// instead of one per 5-minute tick. What can't go out is reported, not guessed.

export interface ApplyAllSummary {
  admitted: number;
  steps: number;
  approved: number;
  /** Approved applications waiting to be submitted when the pass started. */
  queued: number;
  /** Pending drafts still missing required answers. */
  needsAnswers: { reviewItemId: string; title: string; company: string; missing: string[] }[];
  /** Ready jobs on an ATS we can't submit to. */
  manual: { jobId: string; reason: string }[];
  /** Live mode: submissions run in the background; dry run fills and screenshots only. */
  mode: 'live' | 'dry_run';
}

const MAX_SUBMISSIONS = 50;

export async function applyAll(deps: SequencerDeps): Promise<{ summary: ApplyAllSummary; submitting: Promise<ApplyTickResult['outcomes']> }> {
  const { db } = deps;
  const seq = await runSequencer(deps);

  let approved = 0;
  const needsAnswers: ApplyAllSummary['needsAnswers'] = [];
  for (const item of await listReviewItems(db, { kind: ['application'], status: ['pending'], limit: 500 })) {
    const draft = applicationDraftSchema.parse(item.draft);
    if (draft.missingRequired.length) {
      needsAnswers.push({ reviewItemId: item.id, title: draft.title, company: draft.company, missing: draft.missingRequired });
      continue;
    }
    try {
      await approveReviewItem(db, deps.outreachPolicy, item.id, { note: 'apply all' });
      approved++;
    } catch (err) {
      deps.log.warn({ reviewItemId: item.id, err: (err as Error).message }, 'apply all: could not approve');
    }
  }

  const manual = (await jobsInState(db, ['ready_to_apply']))
    .map((r) => ({ jobId: r.jobId, meta: r.metadata as { manualApply?: boolean; applyError?: string } }))
    .filter((r) => r.meta.manualApply)
    .map((r) => ({ jobId: r.jobId, reason: r.meta.applyError ?? 'apply by hand' }));

  const queued = (await listReviewItems(db, { kind: ['application'], status: ['approved'], limit: 500 })).length;
  const summary: ApplyAllSummary = {
    admitted: seq.admitted,
    steps: seq.steps.length,
    approved,
    queued,
    needsAnswers,
    manual,
    mode: deps.applyDeps.dryRun ? 'dry_run' : 'live',
  };

  // A live tick submits one application; keep ticking until nothing is due (or the apply loop holds the lease).
  const submitting = (async () => {
    const outcomes: ApplyTickResult['outcomes'] = [];
    for (let i = 0; i < MAX_SUBMISSIONS; i++) {
      const r = await runApplyTick(deps.applyDeps);
      outcomes.push(...r.outcomes);
      if (r.skipped || !r.outcomes.length || deps.applyDeps.dryRun) break;
    }
    if (outcomes.length) await runSequencer(deps); // move the submitted jobs to applied / failed now
    return outcomes;
  })();
  return { summary, submitting };
}
