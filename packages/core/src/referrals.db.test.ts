import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseAppConfig, preferencesSchema } from '@jobforge/shared';
import { defineActorPlugin, linkedinNoteDraftSchema, type OutreachActionInput } from '@jobforge/plugin-sdk';
import { fakeGmail } from '@jobforge/plugin-sdk/testing';
import {
  createReviewItem,
  getBatchForJob,
  getReviewItem,
  listBatchItems,
  recordPosting,
  setContactHints,
  sql,
  upsertCompany,
  upsertContact,
} from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createFakeProvider, createLLMClient } from '@jobforge/llm';
import actor from '@jobforge/actor-gmail-outreach';
import tracker from '@jobforge/tracker-gmail';
import { normalizePosting } from './normalize.js';
import { approveReviewItem, draftDueFollowups, OutreachError, pollTracker, runSendTick, type OutreachDeps } from './outreach.js';
import { approveBatch, bulletsFromTex, fanOutReferrals, latexToText, rankReferralContacts, referralPanel } from './referrals.js';
import { loadProfileData } from './profile-loader.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();
const DAY = 86_400_000;

/** Stands in for the Phase 9 LinkedIn actor: drafts a note, never executes here. */
const linkedinStub = defineActorPlugin<unknown, OutreachActionInput, z.infer<typeof linkedinNoteDraftSchema>, Record<string, unknown>>({
  manifest: { id: 'actor-linkedin-referral', version: '0.0.1', stage: 'actor', description: 'stub', configSchema: z.object({}), permissions: { domains: [] }, sideEffects: 'external' },
  async prepare(_ctx, input) {
    return linkedinNoteDraftSchema.parse({
      channel: 'linkedin',
      profileUrl: input.contact.linkedinUrl!,
      toName: input.contact.name,
      note: `Hi ${input.contact.name.split(' ')[0]}, would you refer me for ${input.job?.title}?`,
      jobUrl: input.job?.applyUrl ?? null,
    });
  },
  async execute() {
    throw new Error('not in Phase 8 tests');
  },
});

describe('latex bullets', () => {
  it('extracts \\resumeItem bullets as plain text', () => {
    const tex = [
      '\\resumeItem{Built \\textbf{10+ REST APIs} for \\textbf{``Chanakya\'\'} with nested {braces}}',
      '\\resumeItem{Short}',
      '\\resumeItem{Cut p95 latency by 40\\% using \\texttt{Redis} -- and caching}',
    ].join('\n');
    expect(bulletsFromTex(tex)).toEqual([
      { id: 'b1', text: 'Built 10+ REST APIs for "Chanakya" with nested braces' },
      { id: 'b3', text: 'Cut p95 latency by 40% using Redis – and caching' },
    ]);
    expect(latexToText(String.raw`\href{https://x.y}{site} \& more`)).toBe('site & more');
  });
});

describe.skipIf(!adminUrl)('referral fan-out (postgres)', () => {
  let t: TestDb;
  let deps: OutreachDeps & { linkedinAvailable: boolean };
  let clock = new Date('2026-10-05T09:00:00Z');
  const gmail = fakeGmail('asha@gmail.com');
  const ids: Record<string, string> = {};
  const provider = createFakeProvider((req) => {
    const first = /^(\S+)/.exec(req.prompt.split('\n')[1] ?? '')?.[1] ?? 'there';
    if (/follow-up #/.test(req.prompt)) return { subject: 'x', body: `Hi ${first}, a gentle nudge on my referral question below for the role.`, fact_ids: [], confidence: 0.9 };
    return {
      subject: 'Referral: Backend Engineer',
      body: `Hi ${first},\n\nWould you be open to referring me for the Backend Engineer role? I built a Go ledger service handling 2M transactions a day. Happy to send my resume.`,
      bullet_id: 'exp-ledger',
      confidence: 0.9,
    };
  });
  const config = parseAppConfig({ outreach: { perJobReferralCap: 4, spacingMinutes: [0, 0] } });

  async function addJob(externalId: string, title: string): Promise<string> {
    const raw = { externalId, url: `https://boards.greenhouse.io/acme/jobs/${externalId}`, applyUrl: `https://boards.greenhouse.io/acme/jobs/${externalId}`, title, locations: ['Bengaluru'], remotePolicy: null, department: null, descriptionHtml: '<p>Go</p>', postedAt: null, payload: {} };
    return (
      await recordPosting(t.db, { ...normalizePosting(raw, 'Acme'), companyId: ids.company! }, { sourcePlugin: 'source-test', companySourceId: null, externalId, url: raw.url, payload: {} }, new Date())
    ).jobId;
  }

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const registry = new PluginRegistry();
    for (const p of [actor, tracker, linkedinStub]) registry.register(p);
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(),
      dryRun: false,
      llm: createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' }),
      gmail,
      policy: config.outreach,
      now: () => clock,
      random: () => 0.5,
      linkedinAvailable: true,
    };
    ids.company = (await upsertCompany(t.db, { name: 'Acme', domain: 'acme.com' })).id;
    ids.job = await addJob('j1', 'Backend Engineer');
    ids.job2 = await addJob('j2', 'Platform Engineer');
    const c = async (key: string, name: string, extra: Parameters<typeof upsertContact>[1] extends infer P ? Partial<P> : never, hint: string) => {
      ids[key] = (await upsertContact(t.db, { companyId: ids.company!, name, ...extra })).contact.id;
      await setContactHints(t.db, ids[key]!, { roleHint: hint });
    };
    await c('eng', 'Ana Engineer', { email: 'ana@acme.com' }, 'engineer');
    await c('rec', 'Ravi Recruiter', { email: 'ravi@acme.com' }, 'recruiter');
    await c('mgr', 'Mona Manager', { email: 'mona@acme.com' }, 'manager');
    await c('li', 'Lin Kedin', { linkedinUrl: 'https://www.linkedin.com/in/lin-kedin/' }, 'engineer');
    await c('none', 'No Reach', {}, 'engineer');
    await c('old', 'Olga Asked', { email: 'olga@acme.com' }, 'engineer');
    // Olga was asked 10 days ago about something else → in cooldown.
    const prev = await createReviewItem(t.db, { kind: 'outreach', pluginId: 'actor-gmail-outreach', jobId: null, contactId: ids.old!, companyId: ids.company!, draft: {} });
    await t.db.execute(sql`update review_items set status = 'executed', created_at = ${new Date(clock.getTime() - 10 * DAY).toISOString()}::timestamptz where id = ${prev.id}`);
    await loadProfileData(
      t.db,
      [{ id: 'exp-ledger', kind: 'experience', content: 'Built a Go ledger service handling 2M tx/day', metrics: {}, tags: [] }],
      preferencesSchema.parse({ roles: ['Backend Engineer'] }),
    );
  });
  afterAll(async () => t?.drop());

  it('ranks reachable engineers first', async () => {
    const { listContacts } = await import('@jobforge/db');
    const ranked = rankReferralContacts(await listContacts(t.db, { companyId: ids.company! }), 0.3).map((c) => c.name);
    expect(ranked.slice(0, 4)).toEqual(['Ana Engineer', 'Olga Asked', 'Mona Manager', 'Ravi Recruiter']);
    expect(ranked.at(-1)).toBe('No Reach');
  });

  it('fans out one batch of asks to distinct reachable people, skipping cooldowns', async () => {
    const r = await fanOutReferrals(deps, ids.job!);
    expect(r.batch).toMatchObject({ requestedCount: 4, draftedCount: 4, status: 'pending_review' });
    expect(r.shortBy).toBe(0);
    const items = await listBatchItems(t.db, r.batch.id);
    expect(items.map((i) => [i.contactName, i.channel]).sort()).toEqual(
      [['Ana Engineer', 'email'], ['Lin Kedin', 'linkedin'], ['Mona Manager', 'email'], ['Ravi Recruiter', 'email']].sort(),
    );
    expect(r.skipped.map((s) => s.name).sort()).toEqual(['No Reach', 'Olga Asked']);
    const first = await getReviewItem(t.db, items[0]!.id);
    expect(first!.draft).toMatchObject({ resumeBulletId: 'exp-ledger' });
    // resumable: running again adds nobody
    const again = await fanOutReferrals(deps, ids.job!);
    expect(again.drafted).toEqual([]);
    expect((await listBatchItems(t.db, r.batch.id)).length).toBe(4);
  });

  it('a person queued for one job is not asked for another job (cooldown spans jobs)', async () => {
    const r = await fanOutReferrals(deps, ids.job2!, { count: 3 });
    expect(r.drafted).toEqual([]);
    expect(r.shortBy).toBe(3);
  });

  it('one click approves the batch; the per-job cap holds', async () => {
    const batch = (await getBatchForJob(t.db, ids.job!))!;
    const res = await approveBatch(t.db, config.outreach, batch.id);
    expect(res.approved).toHaveLength(4);
    expect(res.failed).toEqual([]);
    // A fifth ask for the same job can't be approved past the cap.
    const extra = await createReviewItem(t.db, { kind: 'referral_ask', pluginId: 'actor-gmail-outreach', jobId: ids.job!, contactId: ids.none!, companyId: ids.company!, batchId: batch.id, draft: { to: 'x@acme.com', toName: 'x', subject: 'hi', body: 'hello there' } });
    await expect(approveReviewItem(t.db, config.outreach, extra.id)).rejects.toMatchObject({ code: 'job_cap' });
  });

  it('sends the email asks one per tick (LinkedIn items are left to their own loop)', async () => {
    for (let i = 0; i < 5; i++) {
      clock = new Date(clock.getTime() + 60_000);
      await runSendTick(deps);
    }
    expect(gmail.sent()).toHaveLength(3);
    const p = await referralPanel(t.db, ids.job!);
    expect(p.batch).toMatchObject({ sentCount: 3, status: 'sending' });
    expect(p.items.find((i) => i.channel === 'linkedin')!.status).toBe('approved');
  });

  it('a reply on one ask marks the batch replied and stops its follow-ups only', async () => {
    clock = new Date(clock.getTime() + 6 * DAY);
    const drafted = await draftDueFollowups(deps);
    expect(drafted.drafted).toBe(3);
    const ana = gmail.sent().find((m) => m.headers.to?.includes('ana@acme.com'))!;
    gmail.receive({ threadId: ana.threadId, from: 'Ana Engineer <ana@acme.com>', subject: 'Re: Referral', body: 'Sure, send it over!', at: clock });
    const s = await pollTracker(deps);
    expect(s.replies).toBe(1);
    const p = await referralPanel(t.db, ids.job!);
    expect(p.batch).toMatchObject({ status: 'replied', repliedCount: 1 });
    const followups = await t.db.execute<{ status: string; note: string | null }>(sql`select status, decision_note as note from review_items where kind = 'followup'`);
    expect(followups.every((f) => f.status === 'cancelled')).toBe(true);
    const ev = await t.db.execute<{ kind: string }>(sql`select kind from events where kind = 'referral.replied'`);
    expect(ev).toHaveLength(1);
    // the replied batch doesn't fan out again
    expect((await fanOutReferrals(deps, ids.job!)).drafted).toEqual([]);
  });

  it('OutreachError codes surface for cooldowns', () => {
    expect(new OutreachError('x', 'cooldown').code).toBe('cooldown');
  });
});
