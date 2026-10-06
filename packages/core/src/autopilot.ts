import type { AppConfig, Logger } from '@jobforge/shared';
import {
  appendEvent,
  autopilotApprovesSince,
  contactsEmailedAtCompanySince,
  listContacts,
  listRankedJobs,
  listResumeVariantsForJob,
  openOutreachForContact,
  sql,
  threadsForContact,
  transitionReviewItem,
  getActiveProfile,
  type ContactRow,
  type DB,
  type ResumeVariantRow,
  type ReviewItemRow,
} from '@jobforge/db';
import { draftOutreach, type OutreachDeps } from './outreach.js';
import { runTailor, type TailorRunDeps } from './tailor-runner.js';

// Autopilot (user ask: "LLM is the sole acting guide; only confused jobs → review").
// For each top-ranked job that hasn't been outreached yet:
//   1. require the match's self-reported confidence >= floor, score >= floor
//   2. ensure a rendered tailored resume exists (reuse latest, or run tailor)
//      -- require tailor confidence >= floor, zero validation errors, PDF rendered
//   3. pick the best unused contact at the company (email_confidence >= floor)
//   4. run the outreach actor's prepare() via draftOutreach (which auto-attaches the resume)
//      -- require draft confidence >= floor
//   5. if all floors pass + safety caps allow, transition the review item to 'approved'
//      with decidedBy='autopilot'. Otherwise leave as 'pending' for human review.
//
// Caps always respected: per-company-per-week, daily send cap (checked by the send loop),
// autopilot max approves per 24h.

const DAY_MS = 86_400_000;

export type AutopilotStage = 'match' | 'tailor' | 'contact' | 'draft' | 'approved' | 'skipped';
export type AutopilotReason =
  | 'already_in_queue'
  | 'already_emailed'
  | 'no_contact'
  | 'match_confidence'
  | 'match_score'
  | 'tailor_confidence'
  | 'tailor_validation'
  | 'tailor_render_failed'
  | 'draft_confidence'
  | 'auto_approve_cap'
  | 'company_cap'
  | 'ok';

export interface AutopilotRunDeps {
  db: DB;
  log: Logger;
  policy: AppConfig['autopilot'];
  outreachPolicy: AppConfig['outreach'];
  outreachDeps: OutreachDeps;
  tailorDeps: TailorRunDeps;
  /** For tests. */
  now?: () => Date;
}

export interface AutopilotDecision {
  jobId: string;
  jobTitle: string;
  company: string;
  stage: AutopilotStage;
  reason: AutopilotReason;
  note?: string;
  reviewItemId?: string;
  matchScore: number | null;
  matchConfidence: number | null;
  tailorConfidence: number | null;
  draftConfidence: number | null;
  overall: number | null;
}

export interface AutopilotSummary {
  considered: number;
  approved: number;
  escalated: number;
  skipped: number;
  decisions: AutopilotDecision[];
}

export async function runAutopilot(deps: AutopilotRunDeps, opts: { limit?: number } = {}): Promise<AutopilotSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const profile = await getActiveProfile(deps.db);
  if (!profile) throw new Error('autopilot: no profile loaded');
  const { policy } = deps;
  const log = deps.log.child({ runner: 'autopilot' });

  const limit = Math.min(policy.candidateBatch, opts.limit ?? policy.candidateBatch);
  const ranked = await listRankedJobs(deps.db, {
    profileVersion: profile.version,
    methods: ['llm'],
    minScore: policy.minMatchScore,
    sort: 'score',
    limit,
  });

  const approvesLast24h = await autopilotApprovesSince(deps.db, new Date(now.getTime() - DAY_MS));
  let remainingBudget = Math.max(0, policy.maxAutoApprovesPerDay - approvesLast24h);
  const decisions: AutopilotDecision[] = [];

  for (const row of ranked.rows) {
    const base: AutopilotDecision = {
      jobId: row.id,
      jobTitle: row.title,
      company: row.company,
      stage: 'match',
      reason: 'ok',
      matchScore: row.score,
      matchConfidence: null,
      tailorConfidence: null,
      draftConfidence: null,
      overall: null,
    };
    const matchConfidence = await loadMatchConfidence(deps.db, row.id, profile.version);
    base.matchConfidence = matchConfidence;
    if (matchConfidence !== null && matchConfidence < policy.confidenceFloor.match) {
      decisions.push({ ...base, stage: 'match', reason: 'match_confidence', note: `${matchConfidence.toFixed(2)} < ${policy.confidenceFloor.match}` });
      continue;
    }
    if ((row.score ?? 0) < policy.minMatchScore) {
      decisions.push({ ...base, stage: 'match', reason: 'match_score', note: `score ${row.score} < floor ${policy.minMatchScore}` });
      continue;
    }

    // Already in queue or already emailed anyone at this company? Autopilot stays out.
    const contacts = await listContacts(deps.db, { companyId: await companyIdFor(deps.db, row.id) });
    const openForAnyContact: ReviewItemRow[] = [];
    for (const c of contacts) {
      openForAnyContact.push(...(await openOutreachForContact(deps.db, c.id)));
    }
    if (openForAnyContact.length) {
      decisions.push({ ...base, stage: 'skipped', reason: 'already_in_queue' });
      continue;
    }
    const alreadyEmailed = new Set(
      (await Promise.all(contacts.map(async (c) => (await threadsForContact(deps.db, c.id)).map(() => c.id)))).flat(),
    );

    // Resume variant: reuse the latest rendered one for this job (any profile version),
    // or run the tailor now. Any validation error or render failure => escalate.
    const variants = await listResumeVariantsForJob(deps.db, row.id);
    let variant: ResumeVariantRow | undefined = variants.find((v) => v.status === 'rendered' && v.profileVersion === profile.version);
    if (!variant) {
      try {
        const r = await runTailor(deps.tailorDeps, { jobId: row.id });
        variant = r.variant;
      } catch (err) {
        log.warn({ jobId: row.id, err: (err as Error).message }, 'autopilot: tailor threw');
        decisions.push({ ...base, stage: 'tailor', reason: 'tailor_render_failed', note: (err as Error).message });
        continue;
      }
    }
    base.tailorConfidence = variant.confidence;
    if (variant.status === 'validation_failed') {
      decisions.push({ ...base, stage: 'tailor', reason: 'tailor_validation', note: variant.error ?? 'validator dropped all bullets' });
      continue;
    }
    if (variant.status === 'render_failed') {
      decisions.push({ ...base, stage: 'tailor', reason: 'tailor_render_failed', note: variant.error ?? 'LaTeX render failed' });
      continue;
    }
    if ((variant.confidence ?? 0) < policy.confidenceFloor.tailor) {
      decisions.push({ ...base, stage: 'tailor', reason: 'tailor_confidence', note: `${(variant.confidence ?? 0).toFixed(2)} < ${policy.confidenceFloor.tailor}` });
      continue;
    }

    // Pick a contact: highest email_confidence that we haven't already emailed.
    const candidate = pickContact(contacts, alreadyEmailed, policy.minEmailConfidence);
    if (!candidate) {
      decisions.push({ ...base, stage: 'contact', reason: 'no_contact', note: 'no active contact with sufficient email confidence' });
      continue;
    }

    // Per-company-per-week cap: if already at limit, autopilot escalates — human can override.
    const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
    const emailedAtCompany = await contactsEmailedAtCompanySince(deps.db, candidate.companyId, sevenDaysAgo);
    if (emailedAtCompany.length >= deps.outreachPolicy.perCompanyPerWeek && !emailedAtCompany.includes(candidate.id)) {
      decisions.push({ ...base, stage: 'contact', reason: 'company_cap', note: `${emailedAtCompany.length} / ${deps.outreachPolicy.perCompanyPerWeek} at ${row.company} in last 7d` });
      continue;
    }

    // Draft via the normal path (auto-attaches the rendered resume).
    let item: ReviewItemRow;
    try {
      item = await draftOutreach(deps.outreachDeps, { contactId: candidate.id, jobId: row.id });
    } catch (err) {
      log.warn({ jobId: row.id, contactId: candidate.id, err: (err as Error).message }, 'autopilot: draftOutreach failed');
      decisions.push({ ...base, stage: 'draft', reason: 'draft_confidence', note: (err as Error).message });
      continue;
    }
    const draft = item.draft as { confidence?: number | null };
    base.draftConfidence = typeof draft.confidence === 'number' ? draft.confidence : null;
    base.reviewItemId = item.id;
    if ((base.draftConfidence ?? 0) < policy.confidenceFloor.outreach) {
      decisions.push({ ...base, stage: 'draft', reason: 'draft_confidence', note: `${(base.draftConfidence ?? 0).toFixed(2)} < ${policy.confidenceFloor.outreach}` });
      continue;
    }

    // All floors cleared. Approve, if budget allows.
    if (remainingBudget <= 0) {
      decisions.push({ ...base, stage: 'skipped', reason: 'auto_approve_cap', note: `${approvesLast24h} auto-approves in last 24h; max ${policy.maxAutoApprovesPerDay}` });
      continue;
    }
    const overall = Math.min(matchConfidence ?? 1, variant.confidence ?? 1, base.draftConfidence ?? 1);
    base.overall = overall;
    const approved = await transitionReviewItem(deps.db, item.id, ['pending'], 'approved', {
      decided: true,
      decidedBy: 'autopilot',
      confidence: overall,
      decisionNote: `autopilot: match ${matchConfidence?.toFixed(2) ?? '-'} / tailor ${variant.confidence?.toFixed(2) ?? '-'} / draft ${base.draftConfidence?.toFixed(2) ?? '-'}`,
    });
    if (!approved) {
      decisions.push({ ...base, stage: 'draft', reason: 'already_in_queue', note: 'item state changed under us' });
      continue;
    }
    remainingBudget--;
    await appendEvent(deps.db, {
      kind: 'autopilot.approved',
      subjectType: 'review_item',
      subjectId: item.id,
      payload: { jobId: row.id, contactId: candidate.id, confidence: { match: matchConfidence, tailor: variant.confidence, draft: base.draftConfidence, overall } },
    });
    decisions.push({ ...base, stage: 'approved', reason: 'ok' });
  }

  const approved = decisions.filter((d) => d.stage === 'approved').length;
  const skipped = decisions.filter((d) => d.stage === 'skipped').length;
  const escalated = decisions.length - approved - skipped;
  log.info({ considered: decisions.length, approved, escalated, skipped }, 'autopilot run finished');
  await appendEvent(deps.db, {
    kind: 'autopilot.run',
    subjectType: 'profile',
    subjectId: profile.version,
    payload: { considered: decisions.length, approved, escalated, skipped },
  });
  return { considered: decisions.length, approved, escalated, skipped, decisions };
}

function pickContact(contacts: ContactRow[], alreadyEmailed: Set<string>, minEmailConfidence: number): ContactRow | undefined {
  return [...contacts]
    .filter((c) => c.status === 'active' && c.email && !alreadyEmailed.has(c.id))
    .filter((c) => (c.emailConfidence ?? 0) >= minEmailConfidence)
    .sort((a, b) => (b.emailConfidence ?? 0) - (a.emailConfidence ?? 0))
    .at(0);
}

async function companyIdFor(db: DB, jobId: string): Promise<string> {
  const [row] = await db.execute<{ company_id: string }>(
    sql`select company_id from jobs where id = ${jobId}`,
  );
  return row!.company_id;
}

async function loadMatchConfidence(db: DB, jobId: string, profileVersion: string): Promise<number | null> {
  const [row] = await db.execute<{ confidence: number | null }>(
    sql`select confidence from match_results where job_id = ${jobId} and profile_version = ${profileVersion}`,
  );
  return row?.confidence ?? null;
}
