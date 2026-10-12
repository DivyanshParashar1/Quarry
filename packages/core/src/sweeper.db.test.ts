import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseAppConfig, preferencesSchema, type AppConfig } from '@quarry/shared';
import { defineTailorPlugin, type MatcherPlugin, type RawPosting, type SourcePlugin, type TailoredResume } from '@quarry/plugin-sdk';
import { fakeGmail } from '@quarry/plugin-sdk/testing';
import {
  enterPipeline,
  getBatchForJob,
  getJobResume,
  getPipelineState,
  getThread,
  listBatchItems,
  listContacts,
  listReviewItems,
  listSourceTargets,
  recordPosting,
  setContactHints,
  setContactImportFields,
  sql,
  transitionPipeline,
  upsertCompany,
  upsertCompanySource,
  upsertContact,
} from '@quarry/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@quarry/db/testing';
import { createHashEmbedder } from '@quarry/embeddings';
import { createFakeProvider, createLLMClient } from '@quarry/llm';
import gmailActor from '@quarry/actor-gmail-outreach';
import gmailTracker from '@quarry/tracker-gmail';
import linkedinManual from '@quarry/actor-linkedin-manual';
import { embedPending } from './embed-runner.js';
import { markLinkedInAccepted, markLinkedInSent } from './linkedin-manual.js';
import { runMatch } from './match-runner.js';
import { normalizePosting } from './normalize.js';
import { draftDueFollowups, runSendTick, type OutreachDeps } from './outreach.js';
import { loadProfileData } from './profile-loader.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { approveBatch, fanOutReferrals } from './referrals.js';
import type { SequencerDeps } from './sequencer.js';
import { runSourceTarget } from './source-runner.js';
import { handleStageEvent, runSweep, type SweepDeps } from './sweeper.js';
import { setStageSink, type StageEvent } from './triggers.js';
import { silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();
const DAY = 86_400_000;
const PDF = new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'library', 'backend.pdf')));

/** One answer that satisfies every outreach schema (zod strips the keys a schema doesn't use). */
const provider = createFakeProvider(() => ({
  subject: 'Referral for the Backend Engineer role',
  body: 'Hi there,\n\nWould you be open to referring me for the Backend Engineer role? I built a Go ledger service. Happy to send my resume.',
  text: 'Hi there, I am applying for the Backend Engineer role and built a Go ledger service handling 2M transactions a day. Would you be open to referring me?',
  fact_ids: ['exp-ledger'],
  bullet_id: 'exp-ledger',
  confidence: 0.9,
}));

const boards = new Map<string, RawPosting[]>();
const fakeSource: SourcePlugin = {
  manifest: { id: 'source-greenhouse', version: '0.0.1', stage: 'source', description: 'fake', configSchema: z.object({}), permissions: { domains: [] }, sideEffects: 'none' },
  async *fetch(_ctx, target) {
    for (const p of boards.get(target.boardToken) ?? []) yield p;
  },
};
const fakeMatcher: MatcherPlugin = {
  manifest: { id: 'matcher-default', version: '0.0.1', stage: 'matcher', description: 'fake', configSchema: z.object({}).passthrough(), permissions: { domains: [] }, sideEffects: 'none' },
  async score(_ctx, jobs) {
    return jobs.map((j) => ({ jobId: j.id, method: 'llm' as const, score: 90, similarity: 0.8, rubric: {}, reasons: 'fit', provider: 'fake', model: 'fake', confidence: 0.9 }));
  },
};
const tailorResult = (ids: string[]): TailoredResume => ({
  tex: '% stub',
  pdf: PDF,
  pages: 1,
  selection: { included_block_ids: ids, bullet_rewrites: [], tech_stack_rewrites: [], skills_reorder: [], rationale: 'stub', confidence: 1 },
  report: [],
  status: 'rendered',
  error: null,
  confidence: 1,
  provider: 'stub',
  model: 'stub',
});
const stubTailor = defineTailorPlugin<Record<string, never>>({
  manifest: { id: 'tailor-resume-latex', version: '0.0.1', stage: 'tailor', description: 'stub', configSchema: z.object({}).default({}), permissions: { domains: [] }, sideEffects: 'none' },
  async tailor() {
    return tailorResult(['header']);
  },
});

const posting = (externalId: string, title: string): RawPosting => ({
  externalId,
  url: `https://boards.greenhouse.io/x/jobs/${externalId}`,
  applyUrl: `https://boards.greenhouse.io/x/jobs/${externalId}`,
  title,
  locations: ['Bengaluru'],
  remotePolicy: null,
  department: null,
  descriptionHtml: '<p>Go services</p>',
  postedAt: new Date('2026-10-01T00:00:00Z'),
  payload: {},
});

describe.skipIf(!adminUrl)('sweeper + triggers (postgres)', () => {
  let t: TestDb;
  let clock = new Date('2026-10-05T09:00:00Z');
  const gmail = fakeGmail('me@gmail.com');
  const config: AppConfig = parseAppConfig({
    autopilot: { enabled: true, minMatchScore: 70 },
    outreach: { perJobReferralCap: 3, spacingMinutes: [0, 0] },
  });
  let deps: OutreachDeps;
  let seq: SequencerDeps;
  const ids: Record<string, string> = {};
  const enqueued: string[][] = [];
  const embedder = createHashEmbedder();

  const match = async (jobIds?: string[]) => {
    await embedPending({ db: t.db, embedder, log: silentLogger });
    return runMatch({ db: t.db, registry: deps.registry, log: silentLogger, limiter: deps.limiter, dryRun: true }, { ...(jobIds ? { jobIds } : {}) });
  };
  const sweepDeps = (cfg: AppConfig = config): SweepDeps => ({
    db: t.db,
    log: silentLogger,
    config: cfg,
    live: false,
    gmailConnected: true,
    now: () => clock,
    enqueueFetch: async (x) => enqueued.push(x),
    outreach: async () => deps,
    match,
    sequencer: async () => seq,
  });

  async function contact(companyId: string, name: string, extra: Parameters<typeof upsertContact>[1] extends infer P ? Partial<P> : never, degree?: 1) {
    const c = (await upsertContact(t.db, { companyId, name, ...extra })).contact;
    await setContactHints(t.db, c.id, { roleHint: 'engineer' });
    if (degree) await setContactImportFields(t.db, c.id, { linkedinDegree: 1 });
    return c.id;
  }

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const registry = new PluginRegistry();
    for (const p of [gmailActor, gmailTracker, linkedinManual, fakeSource, fakeMatcher, stubTailor]) registry.register(p);
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
    };
    const tailorDeps = { ...deps, resumeDir: mkdtempSync(join(tmpdir(), 'quarry-sweep-')), embed: embedder };
    seq = {
      db: t.db,
      log: silentLogger,
      policy: config.autopilot,
      outreachPolicy: config.outreach,
      fanOutDeps: deps,
      tailorDeps,
      applyDeps: { ...deps, openBrowser: async () => ({ newPage: async () => { throw new Error('no browser in tests'); } }) },
      now: () => clock,
    };
    await loadProfileData(
      t.db,
      [{ id: 'exp-ledger', kind: 'experience', content: 'Built a Go ledger service handling 2M tx/day', metrics: {}, tags: [] }],
      preferencesSchema.parse({ roles: ['Backend Engineer'], application: { first_name: 'Jane' } }),
    );
    ids.acme = (await upsertCompany(t.db, { name: 'Acme', domain: 'acme.com' })).id;
    ids.acmeSource = (await upsertCompanySource(t.db, { companyId: ids.acme, atsType: 'greenhouse', boardToken: 'acme' })).id;
    ids.ana = await contact(ids.acme, 'Ana Mail', { email: 'ana@acme.com' });
    ids.cara = await contact(ids.acme, 'Cara Connect', { linkedinUrl: 'https://www.linkedin.com/in/cara-connect/' }, 1);
    ids.lars = await contact(ids.acme, 'Lars Note', { linkedinUrl: 'https://www.linkedin.com/in/lars-note/' });
  });
  afterAll(async () => t?.drop());
  afterEach(() => setStageSink(null));

  it('after "3 days off", one sweep catches up follow-ups and waits; a second sweep adds nothing', async () => {
    // Day 0: a job fanned out to an emailable person, a LinkedIn connection and a non-connection.
    const raw = posting('a1', 'Backend Engineer');
    ids.jobA = (await recordPosting(t.db, { ...normalizePosting(raw, 'Acme'), companyId: ids.acme! }, { sourcePlugin: 'source-greenhouse', companySourceId: ids.acmeSource!, externalId: 'a1', url: raw.url, payload: {} }, clock)).jobId;
    await enterPipeline(t.db, ids.jobA, {});
    const fan = await fanOutReferrals(deps, ids.jobA);
    expect(fan.drafted.map((d) => d.kind ?? d.channel).sort()).toEqual(['email', 'message', 'note']);
    await approveBatch(t.db, config.outreach, fan.batch.id);
    await runSendTick(deps);
    expect(gmail.sent()).toHaveLength(1);
    for (const d of fan.drafted.filter((x) => x.channel === 'linkedin_manual')) await markLinkedInSent(t.db, config.outreach, d.reviewItemId, { at: clock });
    await transitionPipeline(t.db, ids.jobA, ['candidate'], 'referral_pending', 'test', {}, clock);

    // The server was off for three days.
    clock = new Date(clock.getTime() + 3 * DAY);
    const r = await runSweep(sweepDeps());
    const by = Object.fromEntries(r.steps.map((s) => [s.name, s]));
    expect(by.fetch!.result).toEqual({ boards: 1 });
    expect(enqueued).toEqual([[ids.acmeSource]]);
    expect(by.followups!.result).toMatchObject({ drafted: 2, autoApproved: 1 });
    expect(by.apply!.skipped).toBe('not live');

    const followups = await listReviewItems(t.db, { kind: ['followup'], limit: 50 });
    expect(followups.map((f) => [f.pluginId, f.status]).sort()).toEqual([
      ['actor-gmail-outreach', 'approved'],
      ['actor-linkedin-manual', 'pending'],
    ]);
    expect(followups.find((f) => f.pluginId === 'actor-linkedin-manual')!.contactId).toBe(ids.cara);
    expect((await getPipelineState(t.db, ids.jobA))!.state).toBe('ready_to_apply');

    // Running again (another restart, or the next hourly tick) changes nothing.
    const again = await runSweep(sweepDeps());
    expect(again.steps.find((s) => s.name === 'followups')!.result).toMatchObject({ drafted: 0, autoApproved: 0 });
    expect(again.steps.find((s) => s.name === 'fetch')!.result).toEqual({ boards: 0 });
    expect(await listReviewItems(t.db, { kind: ['followup'], limit: 50 })).toHaveLength(2);
  });

  it('with autopilot off, only the free steps run', async () => {
    const off = parseAppConfig({ ...config, autopilot: { ...config.autopilot, enabled: false } });
    const r = await runSweep(sweepDeps(off));
    const skipped = r.steps.filter((s) => s.skipped).map((s) => s.name);
    expect(skipped).toEqual(expect.arrayContaining(['match', 'sequencer', 'followups', 'apply']));
    expect(r.steps.find((s) => s.name === 'deadlines')!.result).toEqual({ expired: 0 });
    expect(r.steps.find((s) => s.name === 'track')!.ok).toBe(true);
  });

  it('a new job flows source → match → resume → fan-out on triggers, without a sweep', async () => {
    ids.beta = (await upsertCompany(t.db, { name: 'Beta', domain: 'beta.io' })).id;
    await upsertCompanySource(t.db, { companyId: ids.beta, atsType: 'greenhouse', boardToken: 'beta' });
    await contact(ids.beta, 'Bea Mail', { email: 'bea@beta.io' });
    await contact(ids.beta, 'Ben Mail', { email: 'ben@beta.io' });
    boards.set('beta', [posting('b1', 'Backend Engineer')]);

    const pending: Promise<void>[] = [];
    const seen: StageEvent['kind'][] = [];
    setStageSink((e) => {
      seen.push(e.kind);
      pending.push(handleStageEvent({ db: t.db, log: silentLogger, match: (jobIds) => match(jobIds), sequencer: async () => seq }, e));
    });
    const [row] = await listSourceTargets(t.db, { companyName: 'Beta' });
    const s = await runSourceTarget({ db: t.db, registry: deps.registry, log: silentLogger, limiter: deps.limiter, dryRun: true }, row!);
    expect(s.jobsCreated).toBe(1);
    // Drain the chain (each handler may emit the next event).
    for (let i = 0; i < pending.length; i++) await pending[i];

    expect(seen).toEqual(['jobs.new', 'job.matched']);
    const [{ id: jobId }] = (await t.db.execute<{ id: string }>(sql`select canonical_job_id as id from raw_postings where external_id = 'b1'`)) as unknown as [{ id: string }];
    expect((await getJobResume(t.db, jobId))?.decision).toMatchObject({ kept: 'generated' });
    expect((await getPipelineState(t.db, jobId))!.state).toBe('referral_pending');
    const batch = (await getBatchForJob(t.db, jobId))!;
    const items = await listBatchItems(t.db, batch.id);
    expect(items.map((i) => i.contactName).sort()).toEqual(['Bea Mail', 'Ben Mail']);
    expect(items.every((i) => i.status === 'approved' && i.decidedBy === 'autopilot')).toBe(true);
  });

  it('"They accepted" drafts the full message on the note\'s thread; it then gets the single 24 h follow-up', async () => {
    const note = (await listReviewItems(t.db, { kind: ['referral_ask'], status: ['executed'], limit: 50 })).find((i) => i.contactId === ids.lars)!;
    const msg = await markLinkedInAccepted(deps, note.id);
    expect(msg).toMatchObject({ kind: 'followup', status: 'pending', contactId: ids.lars });
    expect(msg.draft).toMatchObject({ kind: 'message', purpose: 'after_accept' });
    expect((await listContacts(t.db, { companyId: ids.acme! })).find((c) => c.id === ids.lars)!.linkedinDegree).toBe(1);
    // Accepting twice returns the same draft.
    expect((await markLinkedInAccepted(deps, note.id)).id).toBe(msg.id);

    const sent = await markLinkedInSent(t.db, config.outreach, msg.id, { at: clock });
    expect(sent.thread).toMatchObject({ followupsSent: 0 });
    expect(sent.thread.nextFollowupAt!.getTime()).toBe(clock.getTime() + DAY);

    clock = new Date(clock.getTime() + DAY + 60_000);
    expect(await draftDueFollowups(deps)).toMatchObject({ drafted: 1 });
    const fu = (await listReviewItems(t.db, { kind: ['followup'], status: ['pending'], limit: 50 })).find((i) => i.contactId === ids.lars && (i.draft as { purpose: string }).purpose === 'followup')!;
    const done = await markLinkedInSent(t.db, config.outreach, fu.id, { at: clock });
    expect(done.thread).toMatchObject({ followupsSent: 1, nextFollowupAt: null });
    clock = new Date(clock.getTime() + 5 * DAY);
    expect(await draftDueFollowups(deps)).toMatchObject({ drafted: 0 });
    expect((await getThread(t.db, done.thread.id))!.state).toBe('sent');
  });

});
