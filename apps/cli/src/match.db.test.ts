// End to end over recorded fixtures: fetch -> profile -> embed -> matcher-default
// (fake LLM, hash embedder) -> ranked list. No network, no model download.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { getActiveProfile, listRankedJobs, listSourceTargets, recordLlmCall } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { DomainRateLimiter, embedPending, loadProfile, runMatch, runSourceTarget } from '@jobforge/core';
import { createFakeProvider, createLLMClient } from '@jobforge/llm';
import { createHashEmbedder } from '@jobforge/embeddings';
import { boardUrl } from '@jobforge/source-greenhouse';
import { postingsUrl } from '@jobforge/source-lever';
import { importCompanies, parseCompaniesCsv } from './companies.js';
import { createRegistry } from './plugins.js';

const adminUrl = testDbAdminUrl();
const fixture = (plugin: string, f: string) =>
  readFileSync(fileURLToPath(new URL(`../../../plugins/${plugin}/fixtures/${f}`, import.meta.url)), 'utf8');
const routes: Record<string, string> = {
  [boardUrl('airbnb', true)]: fixture('source-greenhouse', 'airbnb-jobs.json'),
  [postingsUrl('leverdemo')]: fixture('source-lever', 'leverdemo-postings.json'),
};
const fakeFetch = (async (url: URL) => new Response(routes[url.href]!, { status: 200 })) as unknown as typeof fetch;

const log = pino({ level: 'silent' });

describe.skipIf(!adminUrl)('jf match end to end (postgres)', () => {
  let t: TestDb;
  const provider = createFakeProvider((req) => ({
    results: [...req.prompt.matchAll(/^## (J\d+): (.*)$/gm)].map((m) => ({
      ref: m[1],
      stack_fit: 6,
      seniority_fit: 7,
      location_fit: 5,
      eligibility: 9,
      score: /engineer/i.test(m[2]!) ? 81 : 40,
      reasons: `Scored ${m[2]}`,
      concerns: [],
    })),
  }));

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const { rows } = parseCompaniesCsv('name,ats_type,board_token\nAirbnb,greenhouse,airbnb\nLever Demo,lever,leverdemo\n');
    await importCompanies(t.db, rows);
    const registry = createRegistry();
    for (const row of await listSourceTargets(t.db)) {
      await runSourceTarget({ db: t.db, registry, log, limiter: new DomainRateLimiter({ tokens: 1000, intervalMs: 1 }), dryRun: true, fetch: fakeFetch }, row);
    }
  });
  afterAll(async () => t?.drop());

  it('ranks real fixture jobs against a profile with explanations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jf-profile-'));
    writeFileSync(
      join(dir, 'facts.yaml'),
      'facts:\n  - {id: skill-systems, kind: skill, content: Business systems engineering and sales engineering}\n',
    );
    writeFileSync(
      join(dir, 'preferences.yaml'),
      'roles: [Sales Engineer, Business Systems Engineer]\nexclusions:\n  title_keywords: [dentist]\n',
    );
    const loaded = await loadProfile(t.db, dir);
    expect(loaded.factsCreated).toBe(1);

    expect((await embedPending({ db: t.db, embedder: createHashEmbedder(), log })).jobs).toBe(12);

    const llm = createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code', onCall: (r) => recordLlmCall(t.db, r) });
    const registry = createRegistry({ llm: { tasks: {} }, embeddings: { model: '' }, plugins: { 'matcher-default': { minSimilarity: 0.1, batchSize: 5 } } });
    const s = await runMatch({ db: t.db, registry, log, llm, limiter: new DomainRateLimiter(), dryRun: true });
    expect(s.candidates).toBe(12);
    expect(s.filtered).toBe(1); // Dentist
    expect(s.llm + s.prefilter + s.filtered).toBe(12);
    expect(s.llm).toBeGreaterThan(0);

    const version = (await getActiveProfile(t.db))!.version;
    const { rows } = await listRankedJobs(t.db, { profileVersion: version, limit: 20 });
    expect(rows[0]!.title).toMatch(/Engineer/);
    expect(rows[0]).toMatchObject({ method: 'llm', score: 81, reasons: expect.stringMatching(/^Scored /) });
    expect(rows.find((r) => r.title === 'Dentist')).toMatchObject({ method: 'filtered', score: 0 });
    for (const call of provider.calls) expect(call.prompt).toContain('Target roles: Sales Engineer, Business Systems Engineer');

    // Rerun: nothing left to score, no further LLM calls.
    const calls = provider.calls.length;
    expect((await runMatch({ db: t.db, registry, log, llm, limiter: new DomainRateLimiter(), dryRun: true })).candidates).toBe(0);
    expect(provider.calls.length).toBe(calls);
  });
});
