import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { preferencesSchema, type MatcherPlugin } from '@jobforge/plugin-sdk';
import {
  getActiveProfile,
  getJobDetail,
  listRankedJobs,
  matchStats,
  recordLlmCall,
  recordPosting,
  upsertCompany,
  type DB,
} from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createHashEmbedder } from '@jobforge/embeddings';
import { createFakeProvider, createLLMClient } from '@jobforge/llm';
import { embedPending } from './embed-runner.js';
import { runMatch, NoProfileError, type MatchRunDeps } from './match-runner.js';
import { loadProfileData } from './profile-loader.js';
import { normalizePosting } from './normalize.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();

/** Scores every embedded job by asking the (fake) LLM once; filters titles containing "Chef". */
const fakeMatcher: MatcherPlugin = {
  manifest: {
    id: 'matcher-fake',
    version: '0.0.1',
    stage: 'matcher',
    description: 'test',
    configSchema: z.object({}),
    permissions: { domains: [], llm: true },
    sideEffects: 'none',
  },
  async score(ctx, jobs, profile) {
    const res = await ctx.llm!.generate({ task: 'match', system: 's', prompt: profile.summary, schema: z.object({ score: z.number() }) });
    return jobs
      .filter((j) => j.embedding)
      .map((j) =>
        /chef/i.test(j.title)
          ? { jobId: j.id, method: 'filtered' as const, score: 0, similarity: null, rubric: {}, reasons: 'not a chef', provider: null, model: null }
          : { jobId: j.id, method: 'llm' as const, score: res.data.score, similarity: 0.8, rubric: { stack_fit: 9 }, reasons: `fit for ${j.title}`, provider: res.provider, model: res.model },
      );
  },
};

async function addJob(db: DB, companyId: string, company: string, id: string, title: string, desc: string) {
  const raw = {
    externalId: id,
    url: `https://x.example/${id}`,
    applyUrl: null,
    title,
    locations: ['Bengaluru'],
    remotePolicy: null,
    department: null,
    descriptionHtml: `<p>${desc}</p>`,
    postedAt: new Date('2026-09-01T00:00:00Z'),
    payload: {},
  };
  return recordPosting(
    db,
    { ...normalizePosting(raw, company), companyId },
    { sourcePlugin: 'source-test', companySourceId: null, externalId: id, url: raw.url, payload: {} },
    new Date(),
  );
}

describe.skipIf(!adminUrl)('profile -> embed -> match (postgres)', () => {
  let t: TestDb;
  let deps: MatchRunDeps;
  let score = 77;
  const provider = createFakeProvider(() => ({ score }));

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const registry = new PluginRegistry();
    registry.register(fakeMatcher);
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(),
      dryRun: true,
      llm: createLLMClient({
        providers: { 'claude-code': provider },
        defaultProvider: 'claude-code',
        onCall: (rec) => recordLlmCall(t.db, rec),
      }),
    };
    const { id } = await upsertCompany(t.db, { name: 'Acme' });
    await addJob(t.db, id, 'Acme', 'a', 'Backend Engineer', 'Go and Postgres services');
    await addJob(t.db, id, 'Acme', 'b', 'Pastry Chef', 'Croissants');
  });
  afterAll(async () => t?.drop());

  it('requires a loaded profile', async () => {
    await expect(runMatch({ ...deps }, { pluginId: 'matcher-fake' })).rejects.toBeInstanceOf(NoProfileError);
  });

  it('loads the profile idempotently and retires removed facts', async () => {
    const prefs = preferencesSchema.parse({ roles: ['Backend Engineer'], stack: ['Go'] });
    const facts = [
      { id: 'skill-go', kind: 'skill' as const, content: 'Go', metrics: {}, tags: [] },
      { id: 'old', kind: 'project' as const, content: 'Old project', metrics: {}, tags: [] },
    ];
    const first = await loadProfileData(t.db, facts, prefs);
    expect(first).toMatchObject({ snapshotCreated: true, factsCreated: 2 });
    expect(await loadProfileData(t.db, facts, prefs)).toMatchObject({ snapshotCreated: false, factsUnchanged: 2, version: first.version });

    const second = await loadProfileData(t.db, [{ ...facts[0]!, content: 'Go, 3 years' }], prefs);
    expect(second).toMatchObject({ snapshotCreated: true, factsUpdated: 1, factsRetired: 1 });
    const p = await getActiveProfile(t.db);
    expect(p!.version).toBe(second.version);
    expect(p!.facts.map((f) => f.content)).toEqual(['Go, 3 years']);
    const [row] = await t.db.execute<{ version: number; retired: number }>(
      sql`select (select version from profile_facts where id='skill-go') as version, (select count(*)::int from profile_facts where retired_at is not null) as retired`,
    );
    expect(row).toEqual({ version: 2, retired: 1 });
  });

  it('embeds jobs, facts, and the profile once', async () => {
    const embedder = createHashEmbedder();
    expect(await embedPending({ db: t.db, embedder, log: silentLogger })).toEqual({ jobs: 2, facts: 1, profile: true });
    expect(await embedPending({ db: t.db, embedder, log: silentLogger })).toEqual({ jobs: 0, facts: 0, profile: false });
    expect(embedder.calls[0]![0]).toMatch(/^Represent this sentence/);
    expect((await getActiveProfile(t.db))!.embedding).toHaveLength(384);
  });

  it('scores, persists, logs the LLM call, and resumes without rescoring', async () => {
    const s = await runMatch(deps, { pluginId: 'matcher-fake' });
    expect(s).toMatchObject({ candidates: 2, llm: 1, filtered: 1, unscored: 0 });
    expect((await runMatch(deps, { pluginId: 'matcher-fake' })).candidates).toBe(0);

    const [calls] = await t.db.execute<{ n: number; ok: boolean }>(sql`select count(*)::int as n, bool_and(success) as ok from llm_calls`);
    expect(calls).toEqual({ n: 1, ok: true });

    const version = (await getActiveProfile(t.db))!.version;
    const ranked = await listRankedJobs(t.db, { profileVersion: version });
    expect(ranked.total).toBe(2);
    expect(ranked.rows[0]).toMatchObject({ title: 'Backend Engineer', score: 77, method: 'llm', reasons: 'fit for Backend Engineer' });
    expect((await listRankedJobs(t.db, { profileVersion: version, methods: ['llm'] })).total).toBe(1);
    expect((await listRankedJobs(t.db, { profileVersion: version, q: 'chef' })).rows[0]!.method).toBe('filtered');

    const detail = await getJobDetail(t.db, ranked.rows[0]!.id, version);
    expect(detail!.match).toMatchObject({ score: 77, rubric: { stack_fit: 9 }, provider: 'fake' });
    expect(detail!.sources).toHaveLength(1);
    expect(await matchStats(t.db, version)).toEqual({ openJobs: 2, embedded: 2, scored: { llm: 1, prefilter: 0, filtered: 1 }, unscored: 0 });
  });

  it('rescoring replaces results; a changed description clears the embedding', async () => {
    score = 55;
    const s = await runMatch(deps, { pluginId: 'matcher-fake', rescore: true });
    expect(s.llm).toBe(1);
    const version = (await getActiveProfile(t.db))!.version;
    expect((await listRankedJobs(t.db, { profileVersion: version })).rows[0]!.score).toBe(55);

    const [{ id }] = (await t.db.execute<{ id: string }>(sql`select id from companies where name='Acme'`)) as unknown as [{ id: string }];
    await addJob(t.db, id, 'Acme', 'a', 'Backend Engineer', 'Go, Postgres and now Kafka');
    const [e] = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where embedding is null`);
    expect(e!.n).toBe(1);
  });
});
