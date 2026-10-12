import { randomUUID } from 'node:crypto';
import {
  applicationDraftSchema,
  draftConfidence,
  mapAnswers,
  OtpTimeoutError,
  SessionBlockedError,
  UnansweredQuestionsError,
  UnknownLayoutError,
  type ApplicationDraft,
  type ApplicationResult,
  type ApplyInput,
  type FormQuestion,
  type Job,
} from '@quarry/plugin-sdk';
import type { Profile } from '@quarry/shared';
import { answerOpenFields, draftConfidenceWithLlm } from './answers.js';
import {
  appendEvent,
  applyTargetForJob,
  approvedDueItems,
  claimAction,
  countEvents,
  createReviewItem,
  finishAction,
  getActiveProfile,
  getReviewItem,
  latestRenderedResumeForJob,
  listReviewItems,
  reassignAction,
  releaseLease,
  restartAction,
  transitionReviewItem,
  tryLease,
  updatePendingDraft,
  type ReviewItemRow,
} from '@quarry/db';
import { buildContext, type LoadedPlugin } from './plugins.js';
import { isPluginPaused, tenantOverrides, withTenantOverrides } from './ops-state.js';
import { coreApprovedDraft, isCoreApproved, loadJobForOutreach, OutreachError, type OutreachDeps } from './outreach.js';
import type { RawBrowser } from './browser.js';

// Phase 11: ATS auto-apply (Greenhouse, Lever, Ashby; SmartRecruiters since Phase 19,
// Workday since Phase 20, SuccessFactors and Taleo since Phase 21 — best effort:
// a page the actor doesn't recognise becomes an attention item with screenshots).
// Phase 19: blank questions are answered from the answer bank, then the LLM
// (grounded, guardrailed); an emailed verification code is read from Gmail;
// questions that only appear after "Next" send the item back for review.

export const APPLY_ACTORS = {
  greenhouse: 'actor-apply-greenhouse',
  lever: 'actor-apply-lever',
  ashby: 'actor-apply-ashby',
  smartrecruiters: 'actor-apply-smartrecruiters',
  workday: 'actor-apply-workday',
  successfactors: 'actor-apply-successfactors',
  taleo: 'actor-apply-taleo',
} as const;
const APPLY_PLUGIN_IDS = Object.values(APPLY_ACTORS);
const MAX_ATTEMPTS = 2;

export interface ApplyDeps extends OutreachDeps {
  /** A fresh browser (not the LinkedIn session). Only needed for previews and execute. */
  openBrowser?: () => Promise<RawBrowser>;
}

export function applyKey(jobId: string, profileVersion: string): string {
  return `apply:${jobId}:${profileVersion}`;
}

/**
 * Draft an application review item for a job: resolve the ATS posting, take
 * the job's tailored resume, map the form's questions from the profile, and
 * (when a browser is available) fill the form once without submitting and keep
 * the screenshots for the reviewer.
 */
export async function draftApplication(deps: ApplyDeps, jobId: string, opts: { preview?: boolean } = {}): Promise<ReviewItemRow> {
  const { db } = deps;
  const job = await loadJobForOutreach(db, jobId);
  const target = await applyTargetForJob(db, jobId);
  if (!target) throw new OutreachError('auto-apply supports Greenhouse, Lever, Ashby, SmartRecruiters, Workday, SuccessFactors and Taleo postings only; apply to this one by hand', 'invalid_state');
  const profile = await getActiveProfile(db);
  if (!profile) throw new OutreachError('no profile loaded; run `quarry profile load`', 'no_profile');
  const applicant = profile.preferences.application;
  if (!applicant) throw new OutreachError('fill in the `application` section of profile/preferences.yaml and run `quarry profile load`', 'no_profile');
  const resume = await latestRenderedResumeForJob(db, jobId);
  if (!resume?.pdfPath) throw new OutreachError('no rendered resume for this job yet; tailor one first (`quarry tailor <jobId>`)', 'invalid_state');
  const open = (await listReviewItems(db, { kind: ['application'], status: ['pending', 'approved', 'executed'], limit: 500 })).find((i) => i.jobId === jobId);
  if (open) throw new OutreachError(`an application for this job is already ${open.status}`, 'duplicate');

  const pluginId = APPLY_ACTORS[target.ats];
  const actor = await withOverrides(deps, deps.registry.actor(pluginId));
  const input: ApplyInput = {
    job,
    ats: target.ats,
    boardToken: target.boardToken,
    postingId: target.postingId,
    applyUrl: target.url ?? job.applyUrl ?? '',
    profile,
    applicant,
    resume: { path: resume.pdfPath, resumeVariantId: resume.id },
  };
  const log = deps.log.child({ plugin: pluginId, jobId });
  const ctx = buildContext(actor, { ...deps, log, signal: AbortSignal.timeout(2 * 60_000) });
  const prepared = applicationDraftSchema.parse({ ...(await actor.plugin.prepare(ctx, input)), profileVersion: profile.version });
  const draft = await answerDraft(deps, prepared, job, profile);
  let item = await createReviewItem(db, { kind: 'application', pluginId, jobId, contactId: null, companyId: job.companyId, draft });
  await appendEvent(db, { kind: 'review.created', subjectType: 'review_item', subjectId: item.id, payload: { kind: 'application', ats: target.ats, missingRequired: draft.missingRequired } });

  if (opts.preview !== false && deps.openBrowser && actor.plugin.preview) {
    try {
      const pctx = buildContext(actor, { ...deps, browser: await deps.openBrowser(), log, signal: AbortSignal.timeout(3 * 60_000) });
      const shots = await actor.plugin.preview(pctx, draft);
      item = (await updatePendingDraft(db, item.id, { ...draft, previewScreenshots: shots })) ?? item;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'application preview failed; the draft is still reviewable');
    }
  }
  return item;
}

/** Fill blank questions from the answer bank / LLM; recompute what's missing and the confidence. */
async function answerDraft(deps: ApplyDeps, draft: ApplicationDraft, job: Job, profile: Profile): Promise<ApplicationDraft> {
  const { fields, summary } = await answerOpenFields({ db: deps.db, log: deps.log, ...(deps.llm ? { llm: deps.llm } : {}) }, draft.fields, job, profile);
  const missingRequired = fields.filter((f) => f.required && !f.value).map((f) => f.label);
  const base = draftConfidence(fields);
  if (summary.fromBank || summary.fromLlm || summary.rejected.length) {
    await appendEvent(deps.db, { kind: 'application.answered', subjectType: 'job', subjectId: job.id, payload: { ...summary } });
  }
  return applicationDraftSchema.parse({ ...draft, fields, missingRequired, confidence: draftConfidenceWithLlm(base, fields) });
}

export interface ApplyTickResult {
  mode: 'dry_run' | 'live';
  skipped?: string;
  outcomes: { reviewItemId: string; jobId: string | null; ok: boolean; submitted?: boolean; error?: string; screenshots?: string[] }[];
}

/**
 * Submit approved applications, one per tick, under a lease. Dry run fills
 * and screenshots without submitting (items stay approved). The idempotency
 * key apply:{job}:{profile} makes a retried — or duplicated — application a
 * no-op that returns the earlier result.
 */
export async function runApplyTick(deps: ApplyDeps): Promise<ApplyTickResult> {
  const now = deps.now?.() ?? new Date();
  const out: ApplyTickResult = { mode: deps.dryRun ? 'dry_run' : 'live', outcomes: [] };
  if (!deps.openBrowser) return { ...out, skipped: 'no browser available' };
  const owner = randomUUID();
  if (!(await tryLease(deps.db, 'apply.send', owner, 20 * 60_000))) return { ...out, skipped: 'locked' };
  try {
    const active = [];
    for (const id of APPLY_PLUGIN_IDS) if (!(await isPluginPaused(deps.db, id, now))) active.push(id);
    const due = (await Promise.all(active.map((id) => approvedDueItems(deps.db, now, 20, id)))).flat();
    for (const item of due) {
      const fresh = await getReviewItem(deps.db, item.id);
      if (fresh?.status !== 'approved') continue;
      out.outcomes.push(await applyOne(deps, fresh, now));
      if (!deps.dryRun) break; // one real submission per tick
    }
    return out;
  } finally {
    await releaseLease(deps.db, 'apply.send', owner);
  }
}

async function applyOne(deps: ApplyDeps, item: ReviewItemRow, now: Date) {
  const { db } = deps;
  const approved = coreApprovedDraft<ApplicationDraft>(item, (d) => applicationDraftSchema.parse(d));
  const draft = approved.draft;
  const base = { reviewItemId: item.id, jobId: item.jobId };
  const profileVersion = draft.profileVersion ?? (await getActiveProfile(db))?.version ?? 'unknown';
  const key = deps.dryRun ? `dry:${item.id}:${now.getTime()}:${randomUUID()}` : applyKey(item.jobId!, profileVersion);
  const claim = await claimAction(db, { reviewItemId: item.id, pluginId: item.pluginId, idempotencyKey: key, dryRun: deps.dryRun });
  if (claim.existing) {
    if (claim.action.status === 'succeeded') {
      // Already submitted (this item or an earlier one for the same job + profile): never again.
      await finalize(deps, item, claim.action.result as ApplicationResult, true);
      return { ...base, ok: true, submitted: true, screenshots: (claim.action.result as ApplicationResult).screenshots };
    }
    if (claim.action.reviewItemId !== item.id) {
      const owner = await getReviewItem(db, claim.action.reviewItemId);
      if (owner?.status === 'approved') {
        await transitionReviewItem(db, item.id, ['approved'], 'cancelled', { error: 'another application for this job is in flight' });
        return { ...base, ok: false, error: 'duplicate' };
      }
      // The earlier attempt failed for good; this item takes the key over.
      await reassignAction(db, claim.action.id, item.id);
    }
    await restartAction(db, claim.action.id);
  }
  const actor = await withOverrides(deps, deps.registry.actor(item.pluginId));
  const log = deps.log.child({ plugin: item.pluginId, reviewItemId: item.id });
  if (!isCoreApproved(approved)) throw new Error('refusing to execute a draft the core did not approve');
  try {
    // Phase 22: the actor's own audit events (account_created, step_failed with its failure capture) feed the orchestrator.
    const onEvent = (kind: string, data: Record<string, unknown>) =>
      void appendEvent(db, { kind, subjectType: 'review_item', subjectId: item.id, payload: data }).catch((e: unknown) => log.warn({ err: (e as Error).message }, 'could not record a plugin event'));
    const ctx = buildContext(actor, { ...deps, browser: await deps.openBrowser!(), log, signal: AbortSignal.timeout(5 * 60_000), onEvent });
    const result = (await actor.plugin.execute(ctx, approved, key)) as ApplicationResult;
    await finishAction(db, claim.action.id, { status: 'succeeded', result, at: now });
    if (deps.dryRun) {
      await appendEvent(db, { kind: 'application.dry_run', subjectType: 'review_item', subjectId: item.id, payload: { screenshots: result.screenshots } });
    } else {
      await finalize(deps, item, result, false);
    }
    return { ...base, ok: true, submitted: result.submitted, screenshots: result.screenshots };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await finishAction(db, claim.action.id, { status: 'failed', error, at: now });
    if (err instanceof UnansweredQuestionsError) {
      // Nothing was submitted: add the new questions, answer what we can, and send it back for review.
      await reopenWithQuestions(deps, item, draft, err.questions);
      return { ...base, ok: false, error };
    }
    if (err instanceof UnknownLayoutError) {
      // A page the actor can't place won't fix itself on a retry (dry run included): hand it over with the screenshots.
      await transitionReviewItem(db, item.id, ['approved'], 'failed', { error: `needs a manual application: ${error}` });
      await createReviewItem(db, {
        kind: 'attention',
        pluginId: item.pluginId,
        jobId: item.jobId,
        contactId: null,
        companyId: item.companyId,
        draft: {
          title: `Apply to ${draft.company} by hand (unrecognised ${draft.ats} page)`,
          message: `The ${draft.ats} application reached a page Quarry doesn't recognise${err.step ? ` (after "${err.step}")` : ''}, so it stopped instead of guessing. Nothing was submitted. The screenshots show where it stopped; finish at the link, then approve this item. A selector/step override for this employer lets the next application get past it.`,
          reason: 'unknown_layout',
          applicationItemId: item.id,
          url: err.url || draft.applyUrl,
          screenshots: err.screenshots,
        },
      });
      await appendEvent(db, { kind: 'application.unknown_layout', subjectType: 'review_item', subjectId: item.id, payload: { ats: draft.ats, step: err.step, url: err.url, screenshots: err.screenshots } });
      log.warn({ err: error }, 'application stopped on an unrecognised page');
      return { ...base, ok: false, error };
    }
    if (!deps.dryRun) {
      if (err instanceof OtpTimeoutError) {
        await transitionReviewItem(db, item.id, ['approved'], 'failed', { error: `verification email never arrived: finish this application by hand` });
        await createReviewItem(db, {
          kind: 'attention',
          pluginId: item.pluginId,
          jobId: item.jobId,
          contactId: null,
          companyId: item.companyId,
          draft: {
            title: `Finish the application to ${draft.company} by hand`,
            message: `The form asked for an emailed verification code after submitting, and no email from ${err.fromDomains.join(', ')} arrived within ${Math.round(err.waitedMs / 60_000)} minutes. Open the form, enter the code from your inbox, and confirm. Approve this item when done.`,
            reason: 'otp_timeout',
            applicationItemId: item.id,
            url: draft.applyUrl,
          },
        });
        await appendEvent(db, { kind: 'application.otp_timeout', subjectType: 'review_item', subjectId: item.id, payload: { fromDomains: err.fromDomains } });
      } else if (err instanceof SessionBlockedError) {
        // No captcha solving: hand it to the human, with the form ready to open prefilled.
        await transitionReviewItem(db, item.id, ['approved'], 'failed', { error: `needs a manual application: ${err.message}` });
        await createReviewItem(db, {
          kind: 'attention',
          pluginId: item.pluginId,
          jobId: item.jobId,
          contactId: null,
          companyId: item.companyId,
          draft: {
            title: `Finish the application to ${draft.company} (${err.reason === 'captcha' ? 'captcha' : 'blocked'})`,
            message: `${draft.company}'s form ${err.reason === 'captcha' ? 'asked for a captcha' : `was blocked (${err.message})`}, which Quarry never solves. Nothing was submitted. "Open prefilled form" opens it in a browser window on this computer with every answer filled in: solve the captcha, click Submit, then approve this item to mark the job applied.`,
            reason: err.reason,
            applicationItemId: item.id,
            url: draft.applyUrl,
          },
        });
        await appendEvent(db, { kind: 'application.blocked', subjectType: 'review_item', subjectId: item.id, payload: { reason: err.reason } });
      } else {
        await appendEvent(db, { kind: 'application.failed', subjectType: 'review_item', subjectId: item.id, payload: { error } });
        const attempts = await countEvents(db, 'application.failed', item.id);
        await transitionReviewItem(db, item.id, ['approved'], attempts >= MAX_ATTEMPTS ? 'failed' : 'approved', {
          error: attempts >= MAX_ATTEMPTS ? `gave up after ${attempts} attempts: ${error}` : `attempt ${attempts} failed: ${error}`,
        });
      }
    }
    log.warn({ err: error }, 'application failed');
    return { ...base, ok: false, error };
  }
}

/** Phase 22: the actor with any stored per-tenant overrides (orchestrator- or user-set) merged into its config. */
async function withOverrides<P extends LoadedPlugin>(deps: ApplyDeps, loaded: P): Promise<P> {
  const r = withTenantOverrides(loaded, (await tenantOverrides(deps.db))[loaded.manifest.id]);
  if (r.error) deps.log.warn({ plugin: loaded.manifest.id, err: r.error }, 'stored tenant override ignored (invalid)');
  return r.loaded as P;
}

async function reopenWithQuestions(deps: ApplyDeps, item: ReviewItemRow, draft: ApplicationDraft, questions: FormQuestion[]): Promise<void> {
  const { db } = deps;
  const profile = await getActiveProfile(db);
  const job = item.jobId ? await loadJobForOutreach(db, item.jobId).catch(() => null) : null;
  if (!profile?.preferences.application || !job) {
    await transitionReviewItem(db, item.id, ['approved'], 'failed', { error: `the form asked new questions: ${questions.map((q) => q.label).join('; ')}` });
    return;
  }
  const known = new Set(draft.fields.map((f) => f.key));
  const input: ApplyInput = {
    job,
    ats: draft.ats,
    boardToken: '',
    postingId: '',
    applyUrl: draft.applyUrl,
    profile,
    applicant: profile.preferences.application,
    resume: { path: draft.resumePath, resumeVariantId: draft.resumeVariantId },
  };
  const added = mapAnswers(questions.filter((q) => !known.has(q.key)), input).fields;
  const answered = await answerDraft(deps, applicationDraftSchema.parse({ ...draft, fields: [...draft.fields, ...added] }), job, profile);
  const reopened = await transitionReviewItem(db, item.id, ['approved'], 'pending', {
    error: `the form asked ${added.length} more question(s) after "Next"; review the answers and approve again`,
  });
  if (reopened) await updatePendingDraft(db, item.id, answered);
  await appendEvent(db, { kind: 'application.more_questions', subjectType: 'review_item', subjectId: item.id, payload: { questions: added.map((f) => f.label) } });
}

async function finalize(deps: ApplyDeps, item: ReviewItemRow, r: ApplicationResult, replay: boolean): Promise<void> {
  const done = await transitionReviewItem(deps.db, item.id, ['approved'], 'executed', { error: replay ? 'already submitted earlier (not resubmitted)' : null });
  if (!done) return;
  await appendEvent(deps.db, {
    kind: 'application.submitted',
    subjectType: 'job',
    ...(item.jobId ? { subjectId: item.jobId } : {}),
    payload: { reviewItemId: item.id, confirmation: r.confirmation, screenshots: r.screenshots, replay },
  });
}
