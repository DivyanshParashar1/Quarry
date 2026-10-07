import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAppConfig, preferencesSchema } from '@jobforge/shared';
import { fakeBrowser } from '@jobforge/plugin-sdk/testing';
import { getBatchForJob, listReviewItems, recordPosting, setContactHints, sql, upsertCompany, upsertContact } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createFakeProvider, createLLMClient } from '@jobforge/llm';
import linkedinActor from '@jobforge/actor-linkedin-referral';
import linkedinTracker from '@jobforge/tracker-linkedin';
import { normalizePosting } from './normalize.js';
import { approveReviewItem } from './outreach.js';
import { approveBatch, fanOutReferrals, referralPanel } from './referrals.js';
import { linkedinPaused } from './linkedin.js';
import { pollLinkedInTracker, runLinkedInSendTick, type LinkedInSendDeps } from './linkedin-send.js';
import { loadProfileData } from './profile-loader.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { fakeClock, silentLogger } from './test-utils.js';
import type { RawBrowser } from './browser.js';

const adminUrl = testDbAdminUrl();
const P1 = 'https://www.linkedin.com/in/ananya-sharma/';
const P2 = 'https://www.linkedin.com/in/rohit-verma/';

const profile = (name: string) =>
  `<html><head><title>${name} | LinkedIn</title></head><body><main><h1>${name}</h1><button aria-label="Invite to connect">Connect</button></main></body></html>`;
const pending = '<html><head><title>LinkedIn</title></head><body><main><button aria-label="Pending, click to withdraw">Pending</button></main></body></html>';
const checkpoint = '<html><head><title>Security Verification | LinkedIn</title></head><body>Let’s do a quick security check</body></html>';

describe.skipIf(!adminUrl)('LinkedIn send + track loops (postgres)', () => {
  let t: TestDb;
  let deps: LinkedInSendDeps;
  let clock = new Date('2026-10-05T09:00:00Z');
  const ids: Record<string, string> = {};
  let checkpointNext = false;
  const site = fakeBrowser({
    pages: {
      [P1]: () => (checkpointNext ? checkpoint : profile('Ananya Sharma')),
      [P2]: () => (checkpointNext ? checkpoint : profile('Rohit Verma')),
      'https://www.linkedin.com/mynetwork/invite-connect/connections/':
        '<ul><li class="mn-connection-card"><a href="/in/ananya-sharma/"><span class="mn-connection-card__name">Ananya Sharma</span></a><time>Connected 1 hour ago</time></li></ul>',
      'https://www.linkedin.com/messaging/': '<ul></ul>',
    },
    onClick(sel) {
      if (sel.includes('Connect')) return { html: '<div role="dialog"><button>Add a note</button></div>' };
      if (sel.includes('Add a note')) return { html: '<div role="dialog"><textarea name="message"></textarea><button aria-label="Send invitation">Send</button></div>' };
      if (sel.includes('Send invitation')) return { html: pending };
      return undefined;
    },
  });
  const browser: RawBrowser = { newPage: () => site.newPage() };
  const provider = createFakeProvider(() => ({
    note: 'Hi there, I am applying for the Backend Engineer role; I built a Go ledger service. Would you be open to referring me?',
    bullet_id: 'exp-ledger',
    confidence: 0.9,
  }));

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const config = parseAppConfig({
      plugins: { 'actor-linkedin-referral': { screenshotDir: mkdtempSync(join(tmpdir(), 'li-')), typingDelayMs: [0, 0] } },
    });
    const registry = new PluginRegistry();
    for (const p of [linkedinActor, linkedinTracker]) registry.register(p, config.plugins[p.manifest.id] ?? {});
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      // Virtual time: the plugins' 15 s/navigation limit must not sleep in tests.
      limiter: new DomainRateLimiter(undefined, fakeClock()),
      dryRun: false,
      linkedin: config.linkedin,
      enabled: true,
      openBrowser: async () => browser,
      policy: config.outreach,
      llm: createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' }),
      now: () => clock,
      random: () => 0.5,
    };
    ids.company = (await upsertCompany(t.db, { name: 'Walmart' })).id;
    const raw = { externalId: 'w1', url: 'https://x.myworkdayjobs.com/j/1', applyUrl: 'https://x.myworkdayjobs.com/j/1', title: 'Backend Engineer', locations: ['Bengaluru'], remotePolicy: null, department: null, descriptionHtml: '<p>Go</p>', postedAt: null, payload: {} };
    ids.job = (await recordPosting(t.db, { ...normalizePosting(raw, 'Walmart'), companyId: ids.company }, { sourcePlugin: 's', companySourceId: null, externalId: 'w1', url: raw.url, payload: {} }, new Date())).jobId;
    for (const [k, name, url] of [['a', 'Ananya Sharma', P1], ['r', 'Rohit Verma', P2]] as const) {
      ids[k] = (await upsertContact(t.db, { companyId: ids.company, name, linkedinUrl: url })).contact.id;
      await setContactHints(t.db, ids[k]!, { roleHint: 'engineer' });
    }
    await loadProfileData(t.db, [{ id: 'exp-ledger', kind: 'experience', content: 'Built a Go ledger service', metrics: {}, tags: [] }], preferencesSchema.parse({}));
    const fan = await fanOutReferrals({ ...deps, linkedinAvailable: true, gmail: undefined } as never, ids.job, { count: 2 });
    expect(fan.skipped).toEqual([]);
    expect(fan.drafted.map((d) => d.channel)).toEqual(['linkedin', 'linkedin']);
    const r = await approveBatch(t.db, config.outreach, fan.batch.id);
    expect(r.approved).toHaveLength(2);
  });
  afterAll(async () => t?.drop());

  it('previews without a browser when LinkedIn is disabled', async () => {
    const before = site.actions.length;
    const r = await runLinkedInSendTick({ ...deps, enabled: false });
    expect(r.mode).toBe('dry_run');
    expect(r.outcomes.every((o) => o.ok && o.outcome === 'dry_run')).toBe(true);
    expect(site.actions.length).toBe(before);
  });

  it('sends one request per tick, then waits for the random gap', async () => {
    const r1 = await runLinkedInSendTick(deps);
    expect(r1.outcomes).toEqual([expect.objectContaining({ ok: true, outcome: 'sent' })]);
    const r2 = await runLinkedInSendTick(deps);
    expect(r2.waitingUntil).toBeInstanceOf(Date);
    const panel = await referralPanel(t.db, ids.job!);
    expect(panel.batch).toMatchObject({ sentCount: 1, status: 'sending' });
    const threads = await t.db.execute<{ channel: string; gmail_thread_id: string; next_followup_at: Date | null }>(sql`select channel, gmail_thread_id, next_followup_at from outreach_threads`);
    expect(threads).toEqual([{ channel: 'linkedin', gmail_thread_id: `linkedin:${P1}`, next_followup_at: null }]);
  });

  it('a checkpoint pauses everything and raises an attention item; resolving it resumes', async () => {
    clock = new Date(clock.getTime() + 10 * 60_000);
    checkpointNext = true;
    const r = await runLinkedInSendTick(deps);
    expect(r.outcomes[0]).toMatchObject({ ok: false });
    expect(await linkedinPaused(t.db, deps.linkedin, clock)).toMatch(/paused: captcha/);
    const [attention] = await listReviewItems(t.db, { kind: ['attention'], status: ['pending'] });
    expect(attention).toMatchObject({ pluginId: 'linkedin' });
    // the item stays approved and nothing retries while paused
    const again = await runLinkedInSendTick(deps);
    expect(again.skipped).toMatch(/paused/);
    // human fixes it and approves the attention item
    checkpointNext = false;
    await approveReviewItem(t.db, deps.policy, attention!.id);
    clock = new Date(clock.getTime() + 24 * 3600_000);
    const resumed = await runLinkedInSendTick(deps);
    expect(resumed.outcomes).toEqual([expect.objectContaining({ ok: true, outcome: 'sent' })]);
  });

  it('an accepted connection flips the ask to replied and marks the batch', async () => {
    const s = await pollLinkedInTracker(deps);
    expect(s).toMatchObject({ accepted: 1 });
    const batch = await getBatchForJob(t.db, ids.job!);
    expect(batch?.status).toBe('replied');
    const ev = await t.db.execute<{ kind: string }>(sql`select kind from events where kind in ('referral.replied', 'linkedin.accepted') order by created_at`);
    expect(ev.map((e) => e.kind)).toEqual(['linkedin.accepted', 'referral.replied']);
  });

  it('retrying a sent item is a no-op', async () => {
    const before = site.actions.filter((a) => a.type === 'click').length;
    clock = new Date(clock.getTime() + 24 * 3600_000);
    const r = await runLinkedInSendTick(deps);
    expect(r.outcomes).toEqual([]);
    expect(site.actions.filter((a) => a.type === 'click').length).toBe(before);
  });
});
