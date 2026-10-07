import { SessionBlockedError, type EmployeeEnrichment } from '@jobforge/plugin-sdk';
import type { AppConfig, Logger } from '@jobforge/shared';
import {
  appendEvent,
  createReviewItem,
  finishPluginRun,
  getState,
  listReviewItems,
  setCompanyLinkedin,
  setContactHints,
  setState,
  startPluginRun,
  transitionReviewItem,
  upsertContact,
  type DB,
} from '@jobforge/db';
import { loadCompanyRef, enrichContacts } from './contacts-runner.js';
import { buildContext, type ContextDeps, type PluginRegistry } from './plugins.js';
import type { RawBrowser } from './browser.js';

// LinkedIn runtime (Phase 8/9). Everything LinkedIn goes through here so the
// gate (LINKEDIN_ENABLED + live), the health/pause state, and the "a human
// must look" review item are enforced in one place.

export const LINKEDIN_EMPLOYEES = 'enricher-linkedin-employees';
const HEALTH_KEY = 'linkedin.health';

export type LinkedInPolicy = AppConfig['linkedin'];

export interface LinkedInHealth {
  pausedUntil: string | null;
  reason: string | null;
  url: string | null;
  /** Next cool-down length; doubles on each block, resets on resume. */
  cooldownMinutes: number;
  /** The attention review item a human resolves to resume. */
  reviewItemId: string | null;
  since: string | null;
}

export async function linkedinHealth(db: DB, policy: LinkedInPolicy): Promise<LinkedInHealth> {
  return (
    (await getState<LinkedInHealth>(db, HEALTH_KEY)) ?? {
      pausedUntil: null,
      reason: null,
      url: null,
      cooldownMinutes: policy.cooldownMinutes,
      reviewItemId: null,
      since: null,
    }
  );
}

/** Paused = a human hasn't cleared the last block, or the cool-down hasn't elapsed. */
export async function linkedinPaused(db: DB, policy: LinkedInPolicy, now = new Date()): Promise<string | null> {
  const h = await linkedinHealth(db, policy);
  if (h.reviewItemId) return `paused: ${h.reason ?? 'blocked'} — resolve the attention item in the review queue`;
  if (h.pausedUntil && new Date(h.pausedUntil) > now) return `cooling down until ${h.pausedUntil}`;
  return null;
}

/**
 * A challenge/login/restriction page: pause every LinkedIn loop, double the
 * next cool-down, and raise an `attention` review item. No retries until a
 * human resolves it (approve = "fixed, resume"; reject = keep paused).
 */
export async function pauseLinkedIn(db: DB, policy: LinkedInPolicy, err: SessionBlockedError, now = new Date()): Promise<LinkedInHealth> {
  const h = await linkedinHealth(db, policy);
  let reviewItemId = h.reviewItemId;
  if (!reviewItemId) {
    const item = await createReviewItem(db, {
      kind: 'attention',
      pluginId: 'linkedin',
      jobId: null,
      contactId: null,
      companyId: null,
      draft: {
        title: `LinkedIn needs you: ${err.reason}`,
        message:
          err.reason === 'login'
            ? 'The saved LinkedIn session is no longer logged in. Run `jf linkedin login` (opens a browser), then approve this item to resume.'
            : `LinkedIn showed a ${err.reason} page. Open LinkedIn in the dedicated account, clear it by hand, wait, then approve this item to resume.`,
        reason: err.reason,
        url: err.url,
      },
    });
    reviewItemId = item.id;
  }
  const next: LinkedInHealth = {
    pausedUntil: new Date(now.getTime() + h.cooldownMinutes * 60_000).toISOString(),
    reason: err.reason,
    url: err.url,
    cooldownMinutes: Math.min(h.cooldownMinutes * 2, 7 * 24 * 60),
    reviewItemId,
    since: h.since ?? now.toISOString(),
  };
  await setState(db, HEALTH_KEY, next);
  await appendEvent(db, { kind: 'linkedin.paused', subjectType: 'review_item', subjectId: reviewItemId, payload: { reason: err.reason, url: err.url, pausedUntil: next.pausedUntil } });
  return next;
}

/** Clear the pause (after a human resolved the attention item). The cool-down length resets. */
export async function resumeLinkedIn(db: DB, policy: LinkedInPolicy, note = 'resumed'): Promise<void> {
  const h = await linkedinHealth(db, policy);
  if (h.reviewItemId) {
    await transitionReviewItem(db, h.reviewItemId, ['pending', 'approved'], 'executed', { decided: true, decisionNote: note });
  }
  await setState(db, HEALTH_KEY, { ...h, pausedUntil: null, reviewItemId: null, reason: null, url: null, since: null, cooldownMinutes: policy.cooldownMinutes });
  await appendEvent(db, { kind: 'linkedin.resumed', payload: { note } });
}

/** If the human approved the attention item from the review queue, resume. */
export async function syncLinkedInAttention(db: DB, policy: LinkedInPolicy): Promise<void> {
  const h = await linkedinHealth(db, policy);
  if (!h.reviewItemId) return;
  const [item] = await listReviewItems(db, { ids: [h.reviewItemId] });
  if (item?.status === 'approved') await resumeLinkedIn(db, policy, 'approved in review queue');
}

export interface LinkedInDeps extends Omit<ContextDeps, 'signal' | 'log'> {
  db: DB;
  registry: PluginRegistry;
  log: Logger;
  linkedin: LinkedInPolicy;
  /** True only when LINKEDIN_ENABLED=true and the run is live. */
  enabled: boolean;
  /** Launches lazily; never called when disabled or paused. */
  openBrowser: () => Promise<RawBrowser>;
}

export interface EmployeeImport {
  ok: boolean;
  skipped?: string;
  profiles: number;
  contactsCreated: number;
  emailsInferred: number;
  error?: string;
}

/**
 * Find engineers at a company on LinkedIn and add them as contacts (source
 * `linkedin`, with role/seniority/team hints), then infer their emails with
 * the pattern enricher. Gated and pause-aware; a block pauses everything.
 */
export async function importLinkedInEmployees(deps: LinkedInDeps, companyId: string, opts: { maxProfiles?: number } = {}): Promise<EmployeeImport> {
  const res: EmployeeImport = { ok: false, profiles: 0, contactsCreated: 0, emailsInferred: 0 };
  if (!deps.enabled) return { ...res, skipped: 'LinkedIn is disabled (set LINKEDIN_ENABLED=true and run live)' };
  await syncLinkedInAttention(deps.db, deps.linkedin);
  const paused = await linkedinPaused(deps.db, deps.linkedin);
  if (paused) return { ...res, skipped: paused };
  const company = await loadCompanyRef(deps.db, companyId);
  if (!company) return { ...res, error: `company ${companyId} not found` };

  const loaded = deps.registry.enricher(LINKEDIN_EMPLOYEES);
  const runId = await startPluginRun(deps.db, { pluginId: LINKEDIN_EMPLOYEES, stage: 'enricher', targetKey: `company:${companyId}` });
  const log = deps.log.child({ plugin: LINKEDIN_EMPLOYEES, company: company.name });
  try {
    const browser = await deps.openBrowser();
    const base = buildContext<Record<string, unknown>>(loaded, {
      ...deps,
      browser,
      log,
      dryRun: false,
      signal: AbortSignal.timeout(20 * 60_000),
    });
    // Per-call override without mutating the shared plugin config.
    const ctx = opts.maxProfiles ? { ...base, config: { ...base.config, maxProfiles: opts.maxProfiles } } : base;
    const e = (await loaded.plugin.enrich(ctx, null, company)) as unknown as EmployeeEnrichment;
    res.profiles = e.profiles.length;
    if (e.linkedinId || e.linkedinSlug) await setCompanyLinkedin(deps.db, companyId, { linkedinId: e.linkedinId, linkedinSlug: e.linkedinSlug });
    for (const p of e.profiles) {
      const { contact, created } = await upsertContact(deps.db, {
        companyId,
        name: p.name,
        role: p.headline,
        linkedinUrl: p.profileUrl,
        source: 'linkedin',
      });
      await setContactHints(deps.db, contact.id, { roleHint: p.roleHint, seniorityHint: p.seniorityHint, department: p.department });
      if (created) res.contactsCreated++;
    }
    if (res.contactsCreated) {
      const [s] = await enrichContacts(deps, { companyId });
      res.emailsInferred = s?.emailsSet ?? 0;
    }
    res.ok = true;
    await finishPluginRun(deps.db, runId, { status: 'succeeded', itemsIn: res.profiles, itemsOut: res.contactsCreated, meta: { notes: e.notes } });
    await appendEvent(deps.db, { kind: 'linkedin.employees', subjectType: 'company', subjectId: companyId, payload: { ...res } });
  } catch (err) {
    res.error = err instanceof Error ? err.message : String(err);
    await finishPluginRun(deps.db, runId, { status: 'failed', itemsIn: res.profiles, itemsOut: res.contactsCreated, error: res.error });
    if (err instanceof SessionBlockedError) {
      const h = await pauseLinkedIn(deps.db, deps.linkedin, err);
      log.warn({ reason: err.reason, pausedUntil: h.pausedUntil }, 'LinkedIn blocked; paused');
    } else log.warn({ err: res.error }, 'LinkedIn employee search failed');
  }
  return res;
}

/** True when there's at least one approved-but-unresolved attention item for LinkedIn. */
export async function pendingLinkedInAttention(db: DB): Promise<number> {
  const items = await listReviewItems(db, { status: ['pending'], kind: ['attention'], limit: 50 });
  return items.filter((i) => i.pluginId === 'linkedin').length;
}
