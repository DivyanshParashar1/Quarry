import { readFile } from 'node:fs/promises';
import type { ResumeBullet } from '@jobforge/plugin-sdk';
import {
  appendEvent,
  contactsAskedSince,
  createReviewItem,
  ensureBatch,
  getActiveProfile,
  getBatchForJob,
  latestRenderedResumeForJob,
  listBatchItems,
  listContacts,
  listReviewItems,
  refreshBatchCounts,
  updateBatch,
  type BatchItemRow,
  type ContactListRow,
  type DB,
  type ReferralBatchRow,
  type ReviewItemRow,
} from '@jobforge/db';
import { loadCompanyRef } from './contacts-runner.js';
import { approveReviewItem, OutreachError, prepareDraft, resolveResumeAttachment, loadJobForOutreach, type OutreachDeps } from './outreach.js';

export const LINKEDIN_ACTOR = 'actor-linkedin-referral';
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Resume bullets (what a referral ask may cite)
// ---------------------------------------------------------------------------

/** Contents of every `\cmd{...}` with balanced braces. */
function commandArgs(tex: string, cmd: string): string[] {
  const out: string[] = [];
  const needle = `\\${cmd}{`;
  let i = tex.indexOf(needle);
  while (i !== -1) {
    let depth = 1;
    let j = i + needle.length;
    for (; j < tex.length && depth > 0; j++) {
      if (tex[j] === '\\') {
        j++;
        continue;
      }
      if (tex[j] === '{') depth++;
      else if (tex[j] === '}') depth--;
    }
    out.push(tex.slice(i + needle.length, j - 1));
    i = tex.indexOf(needle, j);
  }
  return out;
}

/** LaTeX resume bullet → plain text ("\textbf{10+ REST APIs}" → "10+ REST APIs"). */
export function latexToText(s: string): string {
  return s
    .replace(/\\(textbf|textit|emph|underline|texttt|textsc)\{([^{}]*)\}/g, '$2')
    .replace(/\\href\{[^{}]*\}\{([^{}]*)\}/g, '$1')
    .replace(/``|''/g, '"')
    .replace(/\\([%$&#_{}])/g, '$1')
    .replace(/\\textasciitilde\{?\}?|\\~\{\}/g, '~')
    .replace(/--/g, '–')
    .replace(/\\[a-zA-Z]+\*?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function bulletsFromTex(tex: string): ResumeBullet[] {
  return commandArgs(tex, 'resumeItem')
    .map((b, i) => ({ id: `b${i + 1}`, text: latexToText(b) }))
    .filter((b) => b.text.length > 15);
}

/**
 * Bullets for a job's referral asks: from the job's latest rendered tailored
 * resume (so the ask matches what the referrer will forward), falling back to
 * the profile's experience/project facts.
 */
export async function resumeBulletsForJob(db: DB, jobId: string): Promise<ResumeBullet[]> {
  const v = await latestRenderedResumeForJob(db, jobId);
  const texPath = (v?.bullets as { texPath?: string } | null)?.texPath;
  if (texPath) {
    try {
      const bullets = bulletsFromTex(await readFile(texPath, 'utf8'));
      if (bullets.length) return bullets.slice(0, 20);
    } catch {
      /* file moved; fall back */
    }
  }
  const profile = await getActiveProfile(db);
  return (profile?.facts ?? [])
    .filter((f) => f.kind === 'experience' || f.kind === 'project' || f.kind === 'achievement')
    .map((f) => ({ id: f.id, text: f.content }))
    .slice(0, 20);
}

// ---------------------------------------------------------------------------
// Picking people
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<string, number> = { engineer: 0, manager: 1, leader: 2, recruiter: 3, other: 4 };

/** Who to ask first: engineers (the team), then managers, leaders, recruiters; reachable contacts before unreachable. */
export function rankReferralContacts(contacts: ContactListRow[], minEmailConfidence: number): ContactListRow[] {
  const reach = (c: ContactListRow) => (c.email && (c.emailConfidence ?? 0) >= minEmailConfidence ? 0 : c.linkedinUrl ? 1 : 2);
  return [...contacts].sort(
    (a, b) =>
      reach(a) - reach(b) ||
      (ROLE_RANK[a.roleHint ?? 'other'] ?? 4) - (ROLE_RANK[b.roleHint ?? 'other'] ?? 4) ||
      (b.emailConfidence ?? 0) - (a.emailConfidence ?? 0) ||
      a.name.localeCompare(b.name),
  );
}

/** Email when the address is good enough, else LinkedIn when we have a profile, else nothing. */
export function channelFor(c: ContactListRow, minEmailConfidence: number, linkedinAvailable: boolean): 'email' | 'linkedin' | null {
  if (c.email && (c.emailConfidence ?? 0) >= minEmailConfidence) return 'email';
  if (c.linkedinUrl && linkedinAvailable) return 'linkedin';
  return null;
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

export interface FanOutDeps extends OutreachDeps {
  /** Find more people when the company has too few (LinkedIn search + email patterns). Optional. */
  findMoreContacts?: (companyId: string, jobId: string, wanted: number) => Promise<number>;
  /** True when the LinkedIn actor is registered and enabled. */
  linkedinAvailable?: boolean;
}

export interface FanOutResult {
  batch: ReferralBatchRow;
  drafted: { reviewItemId: string; contactId: string; channel: 'email' | 'linkedin' }[];
  skipped: { contactId: string; name: string; reason: string }[];
  /** How many more asks the batch still wants (0 = full). */
  shortBy: number;
  foundContacts: number;
}

/**
 * PLAN Phase 8 `fanOutReferrals(jobId)`: one batch per job, N `referral_ask`
 * review items to N distinct people at the company (email or LinkedIn),
 * respecting the per-contact cooldown. Resumable: re-running tops the batch
 * up without duplicating anyone already in it.
 */
export async function fanOutReferrals(deps: FanOutDeps, jobId: string, opts: { count?: number } = {}): Promise<FanOutResult> {
  const { db, policy } = deps;
  const now = deps.now?.() ?? new Date();
  const job = await loadJobForOutreach(db, jobId);
  const profile = await getActiveProfile(db);
  if (!profile) throw new OutreachError('no profile loaded; run `jf profile load`', 'no_profile');
  const requested = opts.count ?? policy.perJobReferralCap;
  const { batch } = await ensureBatch(db, jobId, requested);
  if (opts.count && opts.count !== batch.requestedCount) await updateBatch(db, batch.id, { requestedCount: opts.count });
  if (batch.status === 'replied' || batch.status === 'closed') {
    return { batch, drafted: [], skipped: [], shortBy: 0, foundContacts: 0 };
  }

  const existing = await listBatchItems(db, batch.id);
  const live = existing.filter((i) => !['rejected', 'cancelled', 'failed'].includes(i.status));
  const inBatch = new Set(existing.map((i) => i.contactId));
  let wanted = requested - live.length;
  const res: FanOutResult = { batch, drafted: [], skipped: [], shortBy: Math.max(0, wanted), foundContacts: 0 };
  if (wanted <= 0) return { ...res, batch: (await refreshBatchCounts(db, batch.id)) ?? batch };

  const eligible = async () => {
    const all = (await listContacts(db, { companyId: job.companyId })).filter((c) => c.status === 'active' && !inBatch.has(c.id));
    const cooled = await contactsAskedSince(db, all.map((c) => c.id), new Date(now.getTime() - policy.perContactCooldownDays * DAY));
    return { all, usable: all.filter((c) => !cooled.has(c.id) && channelFor(c, policy.referralMinEmailConfidence, !!deps.linkedinAvailable)), cooled };
  };
  let pool = await eligible();
  if (pool.usable.length < wanted && deps.findMoreContacts) {
    res.foundContacts = await deps.findMoreContacts(job.companyId, jobId, wanted - pool.usable.length);
    pool = await eligible();
  }
  for (const c of pool.all) {
    if (pool.cooled.has(c.id)) res.skipped.push({ contactId: c.id, name: c.name, reason: `asked in the last ${policy.perContactCooldownDays} days` });
    else if (!channelFor(c, policy.referralMinEmailConfidence, !!deps.linkedinAvailable)) {
      res.skipped.push({ contactId: c.id, name: c.name, reason: 'no usable email and no LinkedIn profile' });
    }
  }

  const company = (await loadCompanyRef(db, job.companyId))!;
  const bullets = await resumeBulletsForJob(db, jobId);
  const attachments = await resolveResumeAttachment(db, jobId);
  for (const c of rankReferralContacts(pool.usable, policy.referralMinEmailConfidence)) {
    if (wanted <= 0) break;
    const channel = channelFor(c, policy.referralMinEmailConfidence, !!deps.linkedinAvailable)!;
    const pluginId = channel === 'email' ? 'actor-gmail-outreach' : LINKEDIN_ACTOR;
    try {
      const ref = company.contacts.find((x) => x.id === c.id)!;
      const draft = await prepareDraft(deps, pluginId, {
        kind: 'referral_ask',
        job,
        company,
        contact: { ...ref, email: c.email ?? '' },
        profile,
        resumeBullets: bullets,
        ...(channel === 'email' ? { attachments } : {}),
      });
      const item = await createReviewItem(db, {
        kind: 'referral_ask',
        pluginId,
        jobId,
        contactId: c.id,
        companyId: job.companyId,
        batchId: batch.id,
        draft,
      });
      res.drafted.push({ reviewItemId: item.id, contactId: c.id, channel });
      inBatch.add(c.id);
      wanted--;
    } catch (err) {
      res.skipped.push({ contactId: c.id, name: c.name, reason: `draft failed: ${(err as Error).message}` });
    }
  }
  res.shortBy = Math.max(0, wanted);
  const b = (await refreshBatchCounts(db, batch.id)) ?? batch;
  const status = b.sentCount > 0 ? b.status : 'pending_review';
  res.batch = (await updateBatch(db, batch.id, { status, note: res.shortBy ? `short by ${res.shortBy}` : null })) ?? b;
  await appendEvent(db, {
    kind: 'referral.fanout',
    subjectType: 'job',
    subjectId: jobId,
    payload: { batchId: batch.id, drafted: res.drafted.length, shortBy: res.shortBy, emails: res.drafted.filter((d) => d.channel === 'email').length },
  });
  return res;
}

export interface BatchApproveResult {
  approved: string[];
  failed: { reviewItemId: string; error: string }[];
}

/** "One click on a job approves the batch": every pending ask, each still checked against cooldown and cap. */
export async function approveBatch(db: DB, policy: OutreachDeps['policy'], batchId: string, opts: { ids?: string[]; decidedBy?: string } = {}): Promise<BatchApproveResult> {
  const items = await listReviewItems(db, { status: ['pending'], kind: ['referral_ask'], limit: 500 });
  const res: BatchApproveResult = { approved: [], failed: [] };
  for (const it of items.filter((i) => i.batchId === batchId && (!opts.ids || opts.ids.includes(i.id)))) {
    try {
      await approveReviewItem(db, policy, it.id, { note: 'batch approve' });
      res.approved.push(it.id);
    } catch (err) {
      res.failed.push({ reviewItemId: it.id, error: (err as Error).message });
    }
  }
  await appendEvent(db, { kind: 'referral.batch_approved', subjectType: 'referral_batch', subjectId: batchId, payload: { approved: res.approved.length, failed: res.failed.length } });
  return res;
}

export interface ReferralPanel {
  batch: ReferralBatchRow | null;
  items: BatchItemRow[];
}

export async function referralPanel(db: DB, jobId: string): Promise<ReferralPanel> {
  const batch = await getBatchForJob(db, jobId);
  if (!batch) return { batch: null, items: [] };
  return { batch: (await refreshBatchCounts(db, batch.id)) ?? batch, items: await listBatchItems(db, batch.id) };
}

export type { ReviewItemRow };
