import { dirname } from 'node:path';
import { findUp } from '@jobforge/shared';
import { findCompanyByName, getBatchForJob, jobTimeline, listApplications, pipelineStateCounts, resolveIdPrefix, type PipelineState } from '@jobforge/db';
import {
  advanceJob,
  approveBatch,
  draftApplication,
  expireJob,
  fanOutReferrals,
  runApplyTick,
  importLinkedInEmployees,
  launchBrowser,
  linkedinBrowserFactory,
  linkedinHealth,
  linkedinPaused,
  linkedinSessionStore,
  pollLinkedInTracker,
  referralPanel,
  resumeLinkedIn,
  runLinkedInSendTick,
  type LinkedInDeps,
  type SequencerDeps,
} from '@jobforge/core';
import { DomainRateLimiter } from '@jobforge/core';
import { table } from './format.js';
import { createRegistry } from './plugins.js';
import { outreachDeps, tailorDeps } from './runtime.js';
import { CmdError, type CmdCtx } from './outreach-cmds.js';

export interface ReferralValues {
  watch?: boolean | undefined;
  count?: string | undefined;
  live?: boolean | undefined;
  company?: string | undefined;
  limit?: string | undefined;
}

export function repoRoot(): string {
  const ws = findUp('pnpm-workspace.yaml');
  return ws ? dirname(ws) : process.cwd();
}

/** LinkedIn runs only with LINKEDIN_ENABLED=true AND a live run (--live or MODE=live). */
export function linkedinDeps(c: CmdCtx, live: boolean): LinkedInDeps & { closeBrowser: () => Promise<void> } {
  const factory = linkedinBrowserFactory(c.env, repoRoot());
  return {
    db: c.db,
    registry: createRegistry(c.config),
    log: c.log,
    limiter: new DomainRateLimiter(),
    dryRun: !live,
    linkedin: c.config.linkedin,
    enabled: c.env.LINKEDIN_ENABLED && live,
    openBrowser: factory.open,
    saveSession: factory.save,
    closeBrowser: factory.close,
  };
}

export async function referralsCommand(sub: string | undefined, arg: string | undefined, v: ReferralValues, c: CmdCtx): Promise<number> {
  const live = !!v.live || c.env.MODE === 'live';
  if (sub === 'fanout') {
    if (!arg) throw new CmdError('usage: jf referrals fanout <jobId> [--count <n>] [--live]');
    const jobId = await resolveIdPrefix(c.db, 'jobs', arg);
    const deps = await outreachDeps({ env: c.env, config: c.config, db: c.db, log: c.log, live, llm: true });
    const li = linkedinDeps(c, live);
    try {
      const r = await fanOutReferrals(
        {
          ...deps,
          linkedinAvailable: c.env.LINKEDIN_ENABLED,
          findMoreContacts: async (companyId, _jobId, wanted) => {
            const imp = await importLinkedInEmployees(li, companyId, { maxProfiles: Math.max(wanted * 2, c.config.linkedin.profilesPerCompany) });
            if (imp.skipped) c.out(`LinkedIn search skipped: ${imp.skipped}`);
            if (imp.error) c.out(`LinkedIn search failed: ${imp.error}`);
            return imp.contactsCreated;
          },
        },
        jobId,
        v.count ? { count: Number(v.count) } : {},
      );
      c.out(
        `batch ${r.batch.id.slice(0, 8)} · ${r.batch.draftedCount}/${r.batch.requestedCount} asks drafted ` +
          `(${r.drafted.filter((d) => d.channel === 'email').length} email, ${r.drafted.filter((d) => d.channel === 'linkedin').length} LinkedIn new this run)` +
          (r.foundContacts ? ` · ${r.foundContacts} new contacts from LinkedIn` : '') +
          (r.shortBy ? ` · short by ${r.shortBy}` : ''),
      );
      for (const s of r.skipped.slice(0, 15)) c.out(`  - skipped ${s.name}: ${s.reason}`);
      if (r.drafted.length) c.out('Review them in the dashboard or `jf referrals approve <jobId>`.');
      return 0;
    } finally {
      await li.closeBrowser();
    }
  }

  if (sub === 'show') {
    if (!arg) throw new CmdError('usage: jf referrals show <jobId>');
    const p = await referralPanel(c.db, await resolveIdPrefix(c.db, 'jobs', arg));
    if (!p.batch) {
      c.out('No referral batch for this job yet. `jf referrals fanout <jobId>` creates one.');
      return 0;
    }
    const b = p.batch;
    c.out(`batch ${b.id.slice(0, 8)} · ${b.status} · requested ${b.requestedCount} · drafted ${b.draftedCount} · sent ${b.sentCount} · replied ${b.repliedCount}`);
    c.out(
      table(p.items, [
        { header: 'ID', value: (r) => r.id.slice(0, 8) },
        { header: 'CHANNEL', value: (r) => r.channel },
        { header: 'CONTACT', value: (r) => r.contactName ?? '', max: 24 },
        { header: 'ROLE', value: (r) => r.contactRole ?? '', max: 30 },
        { header: 'STATUS', value: (r) => r.status },
        { header: 'THREAD', value: (r) => r.threadState ?? '' },
        { header: 'NOTE', value: (r) => r.error ?? '', max: 40 },
      ]),
    );
    return 0;
  }

  if (sub === 'approve') {
    if (!arg) throw new CmdError('usage: jf referrals approve <jobId>');
    const jobId = await resolveIdPrefix(c.db, 'jobs', arg);
    const batch = await getBatchForJob(c.db, jobId);
    if (!batch) throw new CmdError('no referral batch for this job');
    const r = await approveBatch(c.db, c.config.outreach, batch.id);
    c.out(`approved ${r.approved.length} ask(s)${r.failed.length ? `; ${r.failed.length} refused:` : ''}`);
    for (const f of r.failed) c.out(`  - ${f.reviewItemId.slice(0, 8)}: ${f.error}`);
    c.out('Emails go out via `jf outreach send --live` (or the server loop); LinkedIn notes via `jf linkedin send --live`.');
    return r.failed.length && !r.approved.length ? 1 : 0;
  }
  throw new CmdError('usage: jf referrals fanout|show|approve <jobId>');
}

export async function linkedinCommand(sub: string | undefined, v: ReferralValues, c: CmdCtx): Promise<number> {
  if (sub === 'login') {
    const store = await linkedinSessionStore(c.env, repoRoot());
    c.out(`Opening a browser. Log in to your dedicated LinkedIn account; the session is saved encrypted to ${store.path} (key: ${store.keySource}).`);
    const browser = await launchBrowser({ headless: false, ...(store.exists() ? { storageState: (await store.load()) ?? undefined } : {}) });
    try {
      const page = await browser.newPage();
      await page.goto('https://www.linkedin.com/login');
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        if (/linkedin\.com\/(feed|mynetwork|in\/)/.test(page.url())) break;
        await page.waitForTimeout(2000);
      }
      if (!/linkedin\.com\/(feed|mynetwork|in\/)/.test(page.url())) throw new CmdError('timed out waiting for the LinkedIn feed (10 minutes)');
      await store.save(await browser.storageState!());
      await resumeLinkedIn(c.db, c.config.linkedin, 'logged in');
      c.out('Saved. Subsequent runs are headless.');
      return 0;
    } finally {
      await browser.close?.();
    }
  }
  if (sub === 'status') {
    const store = await linkedinSessionStore(c.env, repoRoot());
    const h = await linkedinHealth(c.db, c.config.linkedin);
    const paused = await linkedinPaused(c.db, c.config.linkedin);
    c.out(
      [
        `enabled: ${c.env.LINKEDIN_ENABLED ? 'yes' : 'no (set LINKEDIN_ENABLED=true)'} · mode ${c.env.MODE}`,
        `session: ${store.exists() ? `saved (${store.path}, key from ${store.keySource})` : 'none — run `jf linkedin login`'}`,
        `health: ${paused ?? 'ok'}${h.reason ? ` (last: ${h.reason} at ${h.url})` : ''}`,
      ].join('\n'),
    );
    return 0;
  }
  if (sub === 'resume') {
    await resumeLinkedIn(c.db, c.config.linkedin, 'resumed from CLI');
    c.out('LinkedIn loops resumed.');
    return 0;
  }
  if (sub === 'employees') {
    if (!v.company) throw new CmdError('usage: jf linkedin employees --company <name> [--limit <n>] [--live]');
    const company = await findCompanyByName(c.db, v.company);
    if (!company) throw new CmdError(`unknown company ${v.company}`);
    const live = !!v.live || c.env.MODE === 'live';
    const li = linkedinDeps(c, live);
    try {
      const r = await importLinkedInEmployees(li, company.id, v.limit ? { maxProfiles: Number(v.limit) } : {});
      if (r.skipped) c.out(`skipped: ${r.skipped}`);
      else c.out(`${r.ok ? 'ok' : `FAILED: ${r.error}`} · ${r.profiles} profiles · ${r.contactsCreated} new contacts · ${r.emailsInferred} emails inferred`);
      return r.ok || r.skipped ? 0 : 1;
    } finally {
      await li.closeBrowser();
    }
  }
  if (sub === 'send') {
    const live = !!v.live || c.env.MODE === 'live';
    const li = linkedinDeps(c, live);
    try {
      for (;;) {
        const r = await runLinkedInSendTick({ ...li, policy: c.config.outreach });
        for (const o of r.outcomes) c.out(`${r.mode === 'dry_run' ? 'DRY RUN would send' : o.ok ? 'SENT' : 'FAILED'} → ${o.profileUrl}${o.outcome && o.outcome !== 'sent' && o.outcome !== 'dry_run' ? ` (${o.outcome})` : ''}${o.error ? ` · ${o.error}` : ''}`);
        for (const h of r.held) c.out(`held ${h.reviewItemId.slice(0, 8)}: ${h.reason}`);
        if (r.skipped) c.out(`skipped: ${r.skipped}`);
        if (r.waitingUntil) c.out(`next request not before ${r.waitingUntil.toISOString()}`);
        if (!r.outcomes.length && !r.skipped && !r.waitingUntil && r.mode === 'live') c.out('nothing approved to send on LinkedIn');
        if (!v.watch || r.mode === 'dry_run' || r.skipped) return 0;
        await new Promise((res) => setTimeout(res, 30_000));
      }
    } finally {
      await li.closeBrowser();
    }
  }
  if (sub === 'track') {
    const li = linkedinDeps(c, !!v.live || c.env.MODE === 'live');
    try {
      const r = await pollLinkedInTracker(li);
      c.out(r.skipped ? `skipped: ${r.skipped}` : `${r.events} events · ${r.accepted} accepted · ${r.replies} replies${r.error ? ` · error: ${r.error}` : ''}`);
      return r.error ? 1 : 0;
    } finally {
      await li.closeBrowser();
    }
  }
  throw new CmdError('usage: jf linkedin login|status|resume|employees|send|track');
}

export async function applyCommand(sub: string | undefined, arg: string | undefined, v: ReferralValues & { 'no-preview'?: boolean | undefined }, c: CmdCtx): Promise<number> {
  const live = !!v.live || c.env.MODE === 'live';
  const holder: { browser: Awaited<ReturnType<typeof launchBrowser>> | null } = { browser: null };
  const base = await outreachDeps({ env: c.env, config: c.config, db: c.db, log: c.log, live });
  const deps = {
    ...base,
    openBrowser: async () => (holder.browser ??= await launchBrowser({ headless: c.env.BROWSER_HEADLESS })),
  };
  try {
    if (sub === 'draft') {
      if (!arg) throw new CmdError('usage: jf apply draft <jobId> [--no-preview]');
      const item = await draftApplication(deps, await resolveIdPrefix(c.db, 'jobs', arg), { preview: !v['no-preview'] });
      const d = item.draft as { fields: { label: string; value: string | null; required: boolean }[]; missingRequired: string[]; previewScreenshots: string[] };
      c.out(`application ${item.id.slice(0, 8)} drafted (${item.pluginId}) · ${d.fields.filter((f) => f.value).length}/${d.fields.length} answered`);
      for (const m of d.missingRequired) c.out(`  ! required, unanswered: ${m}`);
      for (const s of d.previewScreenshots) c.out(`  preview: ${s}`);
      if (d.missingRequired.length) c.out('Answer them in the dashboard review queue before approving.');
      return 0;
    }
    if (sub === 'send') {
      for (;;) {
        const r = await runApplyTick(deps);
        if (r.skipped) c.out(`skipped: ${r.skipped}`);
        for (const o of r.outcomes) {
          c.out(`${r.mode === 'dry_run' ? 'DRY RUN filled' : o.ok ? 'SUBMITTED' : 'FAILED'} ${o.reviewItemId.slice(0, 8)}${o.error ? ` · ${o.error}` : ''}${o.screenshots?.length ? ` · ${o.screenshots.join(', ')}` : ''}`);
        }
        if (!r.outcomes.length) c.out('no approved applications');
        if (!v.watch || r.mode === 'dry_run' || !r.outcomes.length) return 0;
      }
    }
    throw new CmdError('usage: jf apply draft <jobId> | send [--live] [--watch]');
  } finally {
    await holder.browser?.close?.();
  }
}

/** Phase 12 sequencer deps for the CLI (LinkedIn search only when enabled and live). */
export async function sequencerDeps(c: CmdCtx, live: boolean): Promise<SequencerDeps & { close: () => Promise<void> }> {
  const out = await outreachDeps({ env: c.env, config: c.config, db: c.db, log: c.log, live, gmail: true, llm: true });
  const li = linkedinDeps(c, live);
  const holder: { browser: Awaited<ReturnType<typeof launchBrowser>> | null } = { browser: null };
  return {
    db: c.db,
    log: c.log,
    policy: c.config.autopilot,
    outreachPolicy: c.config.outreach,
    fanOutDeps: {
      ...out,
      linkedinAvailable: c.env.LINKEDIN_ENABLED,
      ...(li.enabled
        ? { findMoreContacts: async (companyId: string, _j: string, wanted: number) => (await importLinkedInEmployees(li, companyId, { maxProfiles: Math.max(wanted * 2, c.config.linkedin.profilesPerCompany) })).contactsCreated }
        : {}),
    },
    tailorDeps: tailorDeps({ env: c.env, config: c.config, db: c.db, log: c.log, live }),
    applyDeps: { ...out, openBrowser: async () => (holder.browser ??= await launchBrowser({ headless: c.env.BROWSER_HEADLESS })) },
    async close() {
      await li.closeBrowser();
      await holder.browser?.close?.();
    },
  };
}

export async function pipelineCommand(sub: string | undefined, arg: string | undefined, v: ReferralValues & { reason?: string | undefined; state?: string | undefined }, c: CmdCtx): Promise<number> {
  const live = !!v.live || c.env.MODE === 'live';
  if (!sub || sub === 'list') {
    const states = v.state ? (v.state.split(',') as PipelineState[]) : undefined;
    const r = await listApplications(c.db, { ...(states ? { states } : {}), ...(v.company ? { company: v.company } : {}), limit: v.limit ? Number(v.limit) : 100 });
    const counts = await pipelineStateCounts(c.db);
    c.out(Object.entries(counts).map(([k, n]) => `${k}: ${n}`).join(' · '));
    c.out(
      table(r.rows, [
        { header: 'JOB', value: (x) => x.jobId.slice(0, 8) },
        { header: 'COMPANY', value: (x) => x.company, max: 20 },
        { header: 'TITLE', value: (x) => x.title, max: 40 },
        { header: 'STATE', value: (x) => x.state },
        { header: 'SINCE', value: (x) => x.enteredStateAt.toISOString().slice(0, 16).replace('T', ' ') },
        { header: 'ASKS', value: (x) => (x.batch ? `${x.batch.sent}/${x.batch.requested} sent, ${x.batch.replied} replied` : '') },
        { header: 'APPLY', value: (x) => x.applicationStatus ?? ((x.metadata as { manualApply?: boolean }).manualApply ? 'manual' : '') },
        { header: 'WHY', value: (x) => String((x.metadata as { reason?: string }).reason ?? ''), max: 28 },
      ]),
    );
    return 0;
  }
  if (sub === 'show') {
    if (!arg) throw new CmdError('usage: jf pipeline show <jobId>');
    for (const e of await jobTimeline(c.db, await resolveIdPrefix(c.db, 'jobs', arg))) c.out(`${e.at.toISOString().slice(0, 16).replace('T', ' ')}  ${e.summary}`);
    return 0;
  }
  if (sub === 'advance') {
    if (!arg) throw new CmdError('usage: jf pipeline advance <jobId> [--live]');
    const d = await sequencerDeps(c, live);
    try {
      const r = await advanceJob(d, await resolveIdPrefix(c.db, 'jobs', arg));
      c.out(`job ${r.jobId.slice(0, 8)} is now ${r.state}`);
      return 0;
    } finally {
      await d.close();
    }
  }
  if (sub === 'expire') {
    if (!arg) throw new CmdError('usage: jf pipeline expire <jobId> --reason <text>');
    const r = await expireJob(c.db, await resolveIdPrefix(c.db, 'jobs', arg), v.reason ?? 'expired by hand');
    c.out(`job ${r.jobId.slice(0, 8)} expired`);
    return 0;
  }
  throw new CmdError('usage: jf pipeline list [--state s1,s2] [--company] | show <jobId> | advance <jobId> | expire <jobId> --reason <text>');
}
