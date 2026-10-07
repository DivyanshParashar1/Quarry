import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseAppConfig, preferencesSchema } from '@jobforge/shared';
import { fakeBrowser, fakeGmail } from '@jobforge/plugin-sdk/testing';
import type { SourcePlugin } from '@jobforge/plugin-sdk';
import {
  getBatchForJob,
  getPipelineState,
  insertResumeVariant,
  jobTimeline,
  listApplications,
  listBatchItems,
  listSourceTargets,
  saveMatchResults,
  setContactHints,
  sql,
  upsertCompany,
  upsertCompanySource,
  upsertContact,
} from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createFakeProvider, createLLMClient } from '@jobforge/llm';
import outreachActor from '@jobforge/actor-gmail-outreach';
import tracker from '@jobforge/tracker-gmail';
import greenhouseApply, { formUrl, questionsUrl } from '@jobforge/actor-apply-greenhouse';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { approveReviewItem, pollTracker, runSendTick } from './outreach.js';
import { fanOutReferrals } from './referrals.js';
import { runApplyTick } from './apply.js';
import { runSourceTarget } from './source-runner.js';
import { loadProfileData } from './profile-loader.js';
import { advanceJob, expireJob, runSequencer, type SequencerDeps } from './sequencer.js';
import { fakeClock, silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();
const DAY = 86_400_000;
const gh = (f: string) => readFileSync(fileURLToPath(new URL(`../../../plugins/actor-apply-greenhouse/fixtures/${f}`, import.meta.url)), 'utf8');

/** One posting per board token (= company), always the Greenhouse fixture id for "alpha". */
const source: SourcePlugin = {
  manifest: { id: 'source-greenhouse', version: '0.0.1', stage: 'source', description: 'fake', configSchema: z.object({}), permissions: { domains: [] }, sideEffects: 'none' },
  async *fetch(_ctx, target) {
    const id = target.boardToken === 'alpha' ? '4012345' : `${target.boardToken}-1`;
    yield { externalId: id, url: `https://boards.greenhouse.io/${target.boardToken}/jobs/${id}`, applyUrl: `https://boards.greenhouse.io/${target.boardToken}/jobs/${id}`, title: `Backend Engineer ${target.boardToken}`, locations: ['Bengaluru'], remotePolicy: null, department: null, descriptionHtml: '<p>Go</p>', postedAt: null, payload: {} };
  },
};

describe.skipIf(!adminUrl)('autopilot sequencer (postgres)', () => {
  let t: TestDb;
  let deps: SequencerDeps;
  let clock = new Date('2026-10-05T09:00:00Z');
  const gmail = fakeGmail('asha@gmail.com');
  const jobs: Record<string, string> = {};
  let submissions = 0;

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const config = parseAppConfig({
      outreach: { perJobReferralCap: 2, spacingMinutes: [0, 0] },
      autopilot: { minMatchScore: 60, referralWaitDays: 2, deadlineImminentDays: 3 },
      plugins: { 'actor-apply-greenhouse': { screenshotDir: mkdtempSync(join(tmpdir(), 'seq-')), typingDelayMs: 0, confirmTimeoutMs: 0 } },
    });
    const registry = new PluginRegistry();
    for (const p of [outreachActor, tracker, greenhouseApply, source]) registry.register(p, config.plugins[p.manifest.id] ?? {});
    const provider = createFakeProvider((req) => ({
      subject: 'Referral?',
      body: `Hi ${/^(\S+)/.exec(req.prompt.split('\n')[1] ?? '')?.[1] ?? 'there'}, would you refer me for this role? I built a Go ledger service handling 2M tx/day.`,
      bullet_id: 'exp',
      fact_ids: [],
      confidence: 0.9,
    }));
    const fetch = (async (input: URL | string) =>
      String(input) === questionsUrl('alpha', '4012345') ? new Response(gh('job-questions.json'), { headers: { 'content-type': 'application/json' } }) : new Response('x', { status: 404 })) as typeof globalThis.fetch;
    const site = fakeBrowser({
      pages: { [formUrl('alpha', '4012345')]: gh('embed-form.html') },
      onClick: (s) => (s === '#submit_app' ? (submissions++, { html: gh('confirmation.html') }) : undefined),
    });
    const outreach = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(undefined, fakeClock()),
      fetch,
      dryRun: false,
      llm: createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' }),
      gmail,
      policy: config.outreach,
      now: () => clock,
      random: () => 0.5,
    };
    deps = {
      db: t.db,
      log: silentLogger,
      policy: config.autopilot,
      outreachPolicy: config.outreach,
      fanOutDeps: { ...outreach, linkedinAvailable: false },
      tailorDeps: { ...outreach },
      applyDeps: { ...outreach, openBrowser: async () => ({ newPage: () => site.newPage() }) },
      now: () => clock,
    };
    await loadProfileData(
      t.db,
      [{ id: 'exp', kind: 'experience', content: 'Built a Go ledger service handling 2M tx/day', metrics: {}, tags: [] }],
      preferencesSchema.parse({ application: { first_name: 'Asha', last_name: 'Rao', email: 'asha@example.com', work_authorization: { India: 'yes' }, requires_sponsorship: false, answers: [{ match: 'hear about', answer: 'Careers page' }, { match: 'why do you want', answer: 'The payments work.' }] } }),
    );
    const version = (await t.db.execute<{ version: string }>(sql`select version from profile_snapshots limit 1`))[0]!.version;
    const pdf = join(mkdtempSync(join(tmpdir(), 'seq-pdf-')), 'resume.pdf');
    writeFileSync(pdf, '%PDF-1.4 fake');
    for (const token of ['alpha', 'beta', 'gamma']) {
      const c = await upsertCompany(t.db, { name: token });
      await upsertCompanySource(t.db, { companyId: c.id, atsType: 'greenhouse', boardToken: token });
      const [row] = await listSourceTargets(t.db, { companyName: token });
      await runSourceTarget(outreach, row!);
      jobs[token] = (await t.db.execute<{ id: string }>(sql`select id from jobs where company_id = ${c.id}`))[0]!.id;
      await saveMatchResults(t.db, version, 'matcher-default', [{ jobId: jobs[token]!, method: 'llm', score: 85, similarity: 0.8, rubric: {}, reasons: 'fit', provider: 'f', model: 'f', confidence: 0.9 }]);
      await insertResumeVariant(t.db, { jobId: jobs[token]!, profileVersion: version, pluginId: 'tailor-resume-latex', templateId: 't', factIds: [], bullets: {}, header: {}, validationReport: [], status: 'rendered', pdfPath: pdf, pdfBytes: 1, provider: null, model: null, error: null, confidence: 0.9 });
      for (const n of ['One', 'Two']) {
        const { contact } = await upsertContact(t.db, { companyId: c.id, name: `${token} ${n}`, email: `${n.toLowerCase()}@${token}.com` });
        await setContactHints(t.db, contact.id, { roleHint: 'engineer' });
      }
    }
  });
  afterAll(async () => t?.drop());

  it('backpressure: a full review queue holds back new admissions', async () => {
    // maxPendingReviews 0 = "the queue is already full" without seeding review items.
    const s = await runSequencer({ ...deps, policy: { ...deps.policy, maxPendingReviews: 0 } });
    expect(s.paused).toMatch(/^review_queue_full/);
    expect(s.admitted).toBe(0);
    expect(s.counts.candidate + s.counts.referral_pending).toBe(0);
  });

  it('admits gated jobs, fans out, auto-approves confident asks', async () => {
    const s = await runSequencer(deps);
    expect(s.admitted).toBe(3);
    expect(s.counts).toMatchObject({ candidate: 0, referral_pending: 3 });
    for (const j of Object.values(jobs)) {
      const items = await listBatchItems(t.db, (await getBatchForJob(t.db, j))!.id);
      expect(items.map((i) => [i.status, i.decidedBy])).toEqual([['approved', 'autopilot'], ['approved', 'autopilot']]);
    }
    // Resumable: another tick changes nothing and duplicates nothing.
    const again = await runSequencer(deps);
    expect(again.steps).toEqual([]);
    const n = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from review_items where kind = 'referral_ask'`);
    expect(n[0]!.n).toBe(6);
  });

  it('a reply, an imminent deadline, or the elapsed wait moves jobs to ready_to_apply', async () => {
    for (let i = 0; i < 6; i++) {
      clock = new Date(clock.getTime() + 60_000);
      await runSendTick(deps.fanOutDeps);
    }
    expect(gmail.sent()).toHaveLength(6);
    // alpha: a referrer replies
    const toAlpha = gmail.sent().find((m) => m.headers.to?.includes('@alpha.com'))!;
    gmail.receive({ threadId: toAlpha.threadId, from: 'alpha One <one@alpha.com>', subject: 'Re: Referral?', body: 'Happy to!', at: clock });
    await pollTracker(deps.fanOutDeps);
    // beta: the deadline is the day after tomorrow
    await t.db.execute(sql`update jobs set inferred_deadline = ${new Date(clock.getTime() + 2 * DAY).toISOString().slice(0, 10)}, deadline_confidence = 0.8 where id = ${jobs.beta}`);
    const s1 = await runSequencer(deps);
    expect(s1.steps.filter((x) => x.to === 'ready_to_apply' && x.from === 'referral_pending').map((x) => [x.jobId, x.reason]).sort()).toEqual(
      [[jobs.alpha, 'referral_replied'], [jobs.beta, 'deadline_imminent']].sort(),
    );
    // gamma waits until 2 days after its first ask
    expect((await getPipelineState(t.db, jobs.gamma!))!.state).toBe('referral_pending');
    clock = new Date(clock.getTime() + 2 * DAY + 60_000);
    const s2 = await runSequencer(deps);
    expect(s2.steps.find((x) => x.jobId === jobs.gamma)).toMatchObject({ to: 'ready_to_apply', reason: 'wait_elapsed' });
  });

  it('queues the application (or flags manual), and applied follows the submission', async () => {
    const alpha = (await getPipelineState(t.db, jobs.alpha!))!;
    const appId = (alpha.metadata as { applyReviewItemId?: string }).applyReviewItemId!;
    expect(appId).toBeTruthy();
    // beta/gamma have no Greenhouse question fixture → their drafts fail and say why.
    const beta = (await getPipelineState(t.db, jobs.beta!))!;
    expect((beta.metadata as { applyError?: string }).applyError).toBeTruthy();

    await approveReviewItem(t.db, deps.outreachPolicy, appId);
    await runApplyTick(deps.applyDeps);
    expect(submissions).toBe(1);
    const s = await runSequencer(deps);
    expect(s.steps.find((x) => x.jobId === jobs.alpha)).toMatchObject({ from: 'ready_to_apply', to: 'applied', reason: 'application_submitted' });
  });

  it('expires jobs whose posting closed, and supports manual advance/expire', async () => {
    await t.db.execute(sql`update jobs set closed_at = now(), closed_reason = 'deadline' where id = ${jobs.beta}`);
    const s = await runSequencer(deps);
    expect(s.steps.find((x) => x.jobId === jobs.beta)).toMatchObject({ to: 'expired', reason: 'deadline_passed' });
    const g = await advanceJob(deps, jobs.gamma!);
    expect(g).toMatchObject({ state: 'applied' });
    await expect(expireJob(t.db, jobs.gamma!, 'x')).rejects.toThrow(/already applied/);

    const apps = await listApplications(t.db);
    expect(apps.total).toBe(3);
    expect(apps.rows.map((r) => r.state).sort()).toEqual(['applied', 'applied', 'expired']);
    const tl = await jobTimeline(t.db, jobs.alpha!);
    const transitions = tl.filter((e) => e.kind === 'pipeline.transition').map((e) => e.summary);
    expect(transitions).toEqual([
      '∅ → candidate',
      expect.stringMatching(/^candidate → referral_pending \(fanned_out\)/),
      'referral_pending → ready_to_apply (referral_replied)',
      'ready_to_apply → applied (application_submitted)',
    ]);
    expect(tl.some((e) => e.kind === 'application.submitted')).toBe(true);
  });

  it('a run killed mid fan-out resumes without duplicate asks', async () => {
    const c = await upsertCompany(t.db, { name: 'delta' });
    await upsertCompanySource(t.db, { companyId: c.id, atsType: 'greenhouse', boardToken: 'delta' });
    const [row] = await listSourceTargets(t.db, { companyName: 'delta' });
    await runSourceTarget(deps.fanOutDeps, row!);
    const jobId = (await t.db.execute<{ id: string }>(sql`select id from jobs where company_id = ${c.id}`))[0]!.id;
    for (const n of ['One', 'Two']) await upsertContact(t.db, { companyId: c.id, name: `delta ${n}`, email: `${n.toLowerCase()}@delta.com` });
    await advanceJob(deps, jobId); // none → candidate
    // "crash": the batch was drafted but the state never moved past candidate
    await fanOutReferrals(deps.fanOutDeps, jobId, { count: 2 });
    expect((await getPipelineState(t.db, jobId))!.state).toBe('candidate');
    await runSequencer(deps);
    expect((await getPipelineState(t.db, jobId))!.state).toBe('referral_pending');
    const items = await listBatchItems(t.db, (await getBatchForJob(t.db, jobId))!.id);
    expect(items).toHaveLength(2);
  });
});
