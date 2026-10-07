import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig, preferencesSchema } from '@jobforge/shared';
import { getJobDetail, recordPosting, saveMatchResults, sql, upsertCompany } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createFakeProvider, createLLMClient } from '@jobforge/llm';
import deadlineEnricher from '@jobforge/enricher-deadline';
import { normalizePosting } from './normalize.js';
import { loadProfileData } from './profile-loader.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { isDeadlineImminent, runDeadlines, type DeadlineDeps } from './deadline-runner.js';
import { silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();

describe('isDeadlineImminent', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  it('is true within N days for confident estimates only', () => {
    expect(isDeadlineImminent({ inferredDeadline: '2026-10-09', deadlineConfidence: 0.7 }, now, 3)).toBe(true);
    expect(isDeadlineImminent({ inferredDeadline: '2026-10-20', deadlineConfidence: 0.7 }, now, 3)).toBe(false);
    expect(isDeadlineImminent({ inferredDeadline: '2026-10-09', deadlineConfidence: 0.2 }, now, 3)).toBe(false);
    expect(isDeadlineImminent({ inferredDeadline: null, deadlineConfidence: null }, now, 3)).toBe(false);
  });
});

describe.skipIf(!adminUrl)('deadline runner (postgres)', () => {
  let t: TestDb;
  let deps: DeadlineDeps;
  const ids: Record<string, string> = {};
  const now = new Date('2026-10-07T12:00:00Z');
  const answers: Record<string, unknown> = {
    'Past Role': { deadline: '2026-10-01', confidence: 0.8, rationale: 'Closed on Oct 1 in prior cycles.', sources: ['https://example.com/a'] },
    'Future Role': { deadline: '2026-11-15', confidence: 0.7, rationale: 'Mid-November historically.', sources: ['https://example.com/b'] },
    'Guess Role': { deadline: '2026-09-15', confidence: 0.3, rationale: 'Weak guess from industry norms.', sources: [] },
  };
  const provider = createFakeProvider((req) => answers[/Role: (.+)/.exec(req.prompt)![1]!.trim()], { webSearch: { used: true, citations: [] } });

  const posting = (id: string, title: string) => ({
    externalId: id,
    url: `https://x.example/${id}`,
    applyUrl: `https://x.example/${id}`,
    title,
    locations: ['Bengaluru'],
    remotePolicy: null,
    department: null,
    descriptionHtml: `<p>${title}</p>`,
    postedAt: null,
    payload: {},
  });

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const config = parseAppConfig({});
    const registry = new PluginRegistry();
    registry.register(deadlineEnricher);
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(),
      dryRun: true,
      llm: createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' }),
      policy: config.deadlines,
      now: () => now,
    };
    ids.company = (await upsertCompany(t.db, { name: 'Acme' })).id;
    await loadProfileData(t.db, [], preferencesSchema.parse({ roles: ['SDE'] }));
    const version = (await t.db.execute<{ version: string }>(sql`select version from profile_snapshots limit 1`))[0]!.version;
    for (const [key, title, score] of [['past', 'Past Role', 80], ['future', 'Future Role', 75], ['guess', 'Guess Role', 70], ['low', 'Low Role', 20]] as const) {
      const raw = posting(key, title);
      ids[key] = (await recordPosting(t.db, { ...normalizePosting(raw, 'Acme'), companyId: ids.company }, { sourcePlugin: 's', companySourceId: null, externalId: key, url: raw.url, payload: {} }, now)).jobId;
      await saveMatchResults(t.db, version, 'matcher-default', [{ jobId: ids[key]!, method: 'llm', score, similarity: 0.8, rubric: {}, reasons: 'x', provider: 'fake', model: 'fake', confidence: 0.9 }]);
    }
  });
  afterAll(async () => t?.drop());

  it('estimates well-matched jobs, stores sources, and expires confident passed deadlines', async () => {
    const s = await runDeadlines(deps);
    expect(s).toMatchObject({ considered: 3, estimated: 3, withDate: 3, failed: [] });
    expect(s.expired).toEqual([ids.past]); // the low-confidence passed guess stays open
    const past = await getJobDetail(t.db, ids.past!, null);
    expect(past).toMatchObject({ closedReason: 'deadline', deadline: { date: '2026-10-01', confidence: 0.8, sources: ['https://example.com/a'] } });
    expect(past!.closedAt).not.toBeNull();
    const guess = await getJobDetail(t.db, ids.guess!, null);
    expect(guess).toMatchObject({ closedAt: null, deadline: { confidence: 0.3 } });
    expect(provider.calls.every((c) => c.webSearch)).toBe(true);
  });

  it('is not re-run within staleDays, and an expired job stays closed when its board lists it again', async () => {
    const again = await runDeadlines(deps);
    expect(again.considered).toBe(0);
    const raw = posting('past', 'Past Role');
    await recordPosting(t.db, { ...normalizePosting(raw, 'Acme'), companyId: ids.company! }, { sourcePlugin: 's', companySourceId: null, externalId: 'past', url: raw.url, payload: {} }, new Date());
    expect((await getJobDetail(t.db, ids.past!, null))!.closedReason).toBe('deadline');
    const ev = await t.db.execute<{ kind: string }>(sql`select kind from events where kind = 'job.expired'`);
    expect(ev).toHaveLength(1);
  });

  it('can re-estimate one job on demand', async () => {
    const r = await runDeadlines(deps, { jobIds: [ids.future!], force: true });
    expect(r.estimated).toBe(1);
  });
});
