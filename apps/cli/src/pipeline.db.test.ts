import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { countJobs, listJobs, listSourceTargets } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { DomainRateLimiter, runSourceTarget, type SourceRunDeps } from '@jobforge/core';
import { boardUrl } from '@jobforge/source-greenhouse';
import { postingsUrl } from '@jobforge/source-lever';
import { importCompanies, parseCompaniesCsv } from './companies.js';
import { createRegistry } from '@jobforge/plugins';

const adminUrl = testDbAdminUrl();
const fixture = (plugin: string, f: string) =>
  readFileSync(fileURLToPath(new URL(`../../../plugins/${plugin}/fixtures/${f}`, import.meta.url)), 'utf8');

/** Recorded responses keyed by URL; anything else is a test failure, never a live request. */
const routes: Record<string, { status: number; body: string }> = {
  [boardUrl('airbnb', true)]: { status: 200, body: fixture('source-greenhouse', 'airbnb-jobs.json') },
  [boardUrl('gone', true)]: { status: 404, body: fixture('source-greenhouse', 'not-found.json') },
  [postingsUrl('leverdemo')]: { status: 200, body: fixture('source-lever', 'leverdemo-postings.json') },
};
const fakeFetch = (async (url: URL) => {
  const r = routes[url.href];
  if (!r) throw new Error(`unexpected request ${url.href}`);
  return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

const CSV = `name,ats_type,board_token,tags
Airbnb,greenhouse,airbnb,travel
Gone Inc,greenhouse,gone,
Lever Demo,lever,leverdemo,demo
`;

describe.skipIf(!adminUrl)('jf pipeline with real plugins over fixtures (postgres)', () => {
  let t: TestDb;
  let deps: SourceRunDeps;

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    deps = {
      db: t.db,
      registry: createRegistry(),
      log: pino({ level: 'silent' }),
      limiter: new DomainRateLimiter({ tokens: 1000, intervalMs: 1 }),
      dryRun: true,
      fetch: fakeFetch,
    };
  });
  afterAll(async () => t?.drop());

  it('imports companies idempotently', async () => {
    const { rows, errors } = parseCompaniesCsv(CSV);
    expect(errors).toEqual([]);
    expect(await importCompanies(t.db, rows)).toEqual({
      companiesCreated: 3,
      companiesUpdated: 0,
      sourcesCreated: 3,
      sourcesExisting: 0,
    });
    expect(await importCompanies(t.db, rows)).toEqual({
      companiesCreated: 0,
      companiesUpdated: 3,
      sourcesCreated: 0,
      sourcesExisting: 3,
    });
  });

  it('fetches every board, isolates the failing one, and is idempotent on rerun', async () => {
    const targets = await listSourceTargets(t.db);
    const first = await Promise.all(targets.map((row) => runSourceTarget(deps, row)));
    const byCo = Object.fromEntries(first.map((r) => [r.companyName, r]));
    expect(byCo['Airbnb']).toMatchObject({ ok: true, postings: 6, jobsCreated: 6 });
    expect(byCo['Lever Demo']).toMatchObject({ ok: true, postings: 6 });
    expect(byCo['Gone Inc']).toMatchObject({ ok: false, permanent: true });

    const after1 = await countJobs(t.db);
    expect(after1.rawPostings).toBe(12);

    const second = await Promise.all(targets.map((row) => runSourceTarget(deps, row)));
    expect(second.reduce((a, r) => a + r.jobsCreated + r.jobsClosed, 0)).toBe(0);
    expect(await countJobs(t.db)).toEqual(after1);

    const jobs = await listJobs(t.db, { company: 'airbnb' });
    const london = jobs.find((j) => j.locations[0] === 'London, United Kingdom');
    expect(london).toMatchObject({ title: 'Account Manager', remotePolicy: 'hybrid' });
  });
});
