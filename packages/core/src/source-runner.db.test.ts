import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sql } from '@jobforge/db';
import { HttpError, type RawPosting, type SourcePlugin } from '@jobforge/plugin-sdk';
import {
  countJobs,
  listJobs,
  listSourceTargets,
  upsertCompany,
  upsertCompanySource,
  type AtsType,
  type SourceTargetRow,
} from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { runSourceTarget, type SourceRunDeps } from './source-runner.js';
import { enqueueSourceFetches, QUEUES, registerSourceWorker, startBoss, waitForJobs } from './queue.js';
import { fakeClock, silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();

/** boardToken -> postings to yield, or an error to throw. */
const boards = new Map<string, RawPosting[] | Error>();

function fakeSource(id: string): SourcePlugin {
  return {
    manifest: {
      id,
      version: '0.0.1',
      stage: 'source',
      description: 'fake',
      configSchema: z.object({}),
      permissions: { domains: [] },
      sideEffects: 'none',
    },
    async *fetch(_ctx, target) {
      const b = boards.get(target.boardToken);
      if (b instanceof Error) throw b;
      for (const p of b ?? []) yield p;
    },
  };
}

function posting(externalId: string, title: string, location = 'Remote', extra: Partial<RawPosting> = {}): RawPosting {
  return {
    externalId,
    url: `https://jobs.example.com/${externalId}`,
    applyUrl: null,
    title,
    locations: [location],
    remotePolicy: null,
    department: null,
    descriptionHtml: `<p>${title}</p>`,
    postedAt: new Date('2026-09-01T00:00:00Z'),
    payload: { externalId },
    ...extra,
  };
}

describe.skipIf(!adminUrl)('source runner (postgres)', () => {
  let t: TestDb;
  let deps: SourceRunDeps;

  async function addBoard(company: string, ats: AtsType, token: string): Promise<SourceTargetRow> {
    const c = await upsertCompany(t.db, { name: company });
    await upsertCompanySource(t.db, { companyId: c.id, atsType: ats, boardToken: token });
    const [row] = await listSourceTargets(t.db, { companyName: company, atsTypes: [ats] });
    return row!;
  }

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const registry = new PluginRegistry();
    registry.register(fakeSource('source-greenhouse'));
    registry.register(fakeSource('source-lever'));
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(undefined, fakeClock()),
      dryRun: true,
    };
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    boards.clear();
    await t.db.execute(sql`truncate companies, company_sources, jobs, raw_postings, plugin_runs, events cascade`);
  });

  it('creates canonical jobs and is idempotent on rerun', async () => {
    const row = await addBoard('Acme', 'greenhouse', 'acme');
    boards.set('acme', [posting('1', 'Backend Engineer'), posting('2', 'Frontend Engineer')]);

    const first = await runSourceTarget(deps, row);
    expect(first).toMatchObject({ ok: true, postings: 2, jobsCreated: 2, jobsUpdated: 0, jobsClosed: 0 });

    const second = await runSourceTarget(deps, row);
    expect(second).toMatchObject({ ok: true, postings: 2, jobsCreated: 0, jobsUpdated: 2, jobsClosed: 0 });

    expect(await countJobs(t.db)).toEqual({ open: 2, closed: 0, rawPostings: 2 });
    const runs = await t.db.execute<{ status: string }>(sql`select status from plugin_runs`);
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('dedups the same role across postings and across ATS sources', async () => {
    const gh = await addBoard('Acme', 'greenhouse', 'acme');
    const lv = await addBoard('Acme', 'lever', 'acme-lever');
    boards.set('acme', [posting('1', 'Sr. Backend Engineer', 'Berlin'), posting('2', 'Senior Backend Engineer', 'berlin')]);
    boards.set('acme-lever', [posting('abc', 'Senior Backend Engineer', 'Berlin, ')]);

    await runSourceTarget(deps, gh);
    const r = await runSourceTarget(deps, lv);
    expect(r.jobsCreated).toBe(0);

    const jobs = await listJobs(t.db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.sources).toBe(3);
    expect(jobs[0]!.seniority).toBe('senior');
  });

  it('closes jobs that disappear from a board and reopens them when they return', async () => {
    const row = await addBoard('Acme', 'greenhouse', 'acme');
    boards.set('acme', [posting('1', 'Backend Engineer'), posting('2', 'Data Engineer')]);
    await runSourceTarget(deps, row);

    boards.set('acme', [posting('1', 'Backend Engineer')]);
    expect((await runSourceTarget(deps, row)).jobsClosed).toBe(1);
    expect(await countJobs(t.db)).toMatchObject({ open: 1, closed: 1 });

    boards.set('acme', [posting('1', 'Backend Engineer'), posting('2', 'Data Engineer')]);
    await runSourceTarget(deps, row);
    expect(await countJobs(t.db)).toMatchObject({ open: 2, closed: 0 });
  });

  it('does not close a job still listed by another source', async () => {
    const gh = await addBoard('Acme', 'greenhouse', 'acme');
    const lv = await addBoard('Acme', 'lever', 'acme-lever');
    boards.set('acme', [posting('1', 'Backend Engineer')]);
    boards.set('acme-lever', [posting('x', 'Backend Engineer')]);
    await runSourceTarget(deps, gh);
    await runSourceTarget(deps, lv);

    boards.set('acme', []);
    expect((await runSourceTarget(deps, gh)).jobsClosed).toBe(0);
    expect(await countJobs(t.db)).toMatchObject({ open: 1 });
  });

  it('records a failed run without closing jobs, and skips invalid postings', async () => {
    const row = await addBoard('Acme', 'greenhouse', 'acme');
    boards.set('acme', [posting('1', 'Backend Engineer'), { ...posting('2', 'x'), title: '' }]);
    const r = await runSourceTarget(deps, row);
    expect(r).toMatchObject({ ok: true, invalid: 1, jobsCreated: 1 });

    boards.set('acme', new HttpError('GET -> 404', 'https://x', 404));
    const failed = await runSourceTarget(deps, row);
    expect(failed).toMatchObject({ ok: false, permanent: true });
    expect(await countJobs(t.db)).toMatchObject({ open: 1, closed: 0 });

    const [src] = await listSourceTargets(t.db, { companyName: 'Acme' });
    expect(src!.status).toBe('error');
    const ev = await t.db.execute<{ kind: string }>(sql`select kind from events order by created_at`);
    expect(ev.map((e) => e.kind)).toEqual(['source.run.succeeded', 'source.run.failed']);
  });

  it('runs boards through pg-boss; one failing board does not stop the others', async () => {
    const rows = [
      await addBoard('Alpha', 'greenhouse', 'alpha'),
      await addBoard('Broken', 'greenhouse', 'broken'),
      await addBoard('Gamma', 'lever', 'gamma'),
    ];
    boards.set('alpha', [posting('a1', 'Engineer')]);
    boards.set('broken', new HttpError('GET -> 404', 'https://x', 404));
    boards.set('gamma', [posting('g1', 'Engineer'), posting('g2', 'Designer')]);

    const boss = await startBoss(t.url);
    try {
      await registerSourceWorker(boss, deps, { concurrency: 2 });
      const ids = await enqueueSourceFetches(
        boss,
        rows.map((r) => r.companySourceId),
      );
      const results = await waitForJobs(boss, QUEUES.sourceFetch, ids, { pollMs: 100, timeoutMs: 15_000 });
      const outputs = [...results.values()].map((r) => r.output as { companyName: string; ok: boolean });
      expect([...results.values()].every((r) => r.state === 'completed')).toBe(true);
      expect(outputs.find((o) => o.companyName === 'Broken')?.ok).toBe(false);
      expect(outputs.filter((o) => o.ok)).toHaveLength(2);
    } finally {
      await boss.stop({ graceful: false });
    }
    expect(await countJobs(t.db)).toMatchObject({ open: 3 });
  });
});
