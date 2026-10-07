import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { finishPluginRun, listSourceTargets, setCompanyTags, sql, startPluginRun, upsertCompany, upsertCompanySource } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { parseAppConfig } from '@jobforge/shared';
import { silentLogger } from '../test-utils.js';
import type { PageFetcher, PageResponse } from './page-fetcher.js';
import { runAtsRecheck, runNightlyDiscovery } from './continuous.js';

const adminUrl = testDbAdminUrl();
const DAY = 86_400_000;

function pagesFrom(routes: Record<string, Partial<PageResponse> & { redirectTo?: string }>): PageFetcher {
  return {
    async get(url) {
      const r = routes[url];
      if (r?.redirectTo) return { status: 200, url: r.redirectTo, chain: [url, r.redirectTo], body: '', contentType: 'text/html' };
      if (!r) return { status: 404, url, chain: [url], body: '', contentType: 'text/html' };
      return { status: 200, url, chain: [url], body: r.body ?? '', contentType: r.contentType ?? 'text/html' };
    },
  };
}

describe.skipIf(!adminUrl)('continuous discovery (postgres)', () => {
  let t: TestDb;
  const config = parseAppConfig({ discovery: { lists: { 'gcc-journal': { enabled: false } } } }).discovery;
  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
  });
  afterAll(async () => t?.drop());
  beforeEach(async () => {
    await t.db.execute(sql`truncate companies, company_sources, plugin_runs, events cascade`);
  });

  it('nightly: runs enabled lists (skipping LLM ones without an LLM) and queues the new boards', async () => {
    const pages = pagesFrom({
      'https://yc-oss.github.io/api/companies/all.json': {
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'Hasura', website: 'https://hasura.io', regions: ['India'], isHiring: true, status: 'Active' }]),
      },
      'https://hasura.io/careers': { redirectTo: 'https://jobs.ashbyhq.com/hasura' },
    });
    const queued: string[][] = [];
    const s = await runNightlyDiscovery({ db: t.db, pages, log: silentLogger, enqueueFetch: async (ids) => (queued.push(ids), ids) }, config);
    expect(s.lists.map((l) => l.list)).toEqual(['yc']); // gcc-journal disabled; wellfound/internshala/hirect need an LLM
    expect(s).toMatchObject({ added: 1, newSources: 1, queuedFetches: 1 });
    expect(queued[0]).toHaveLength(1);
    // a second night finds nothing new
    const again = await runNightlyDiscovery({ db: t.db, pages, log: silentLogger }, config);
    expect(again.added).toBe(0);
  });

  it('recheck: a silent Greenhouse → Workday move adds the new board and marks the old one stale', async () => {
    const c = await upsertCompany(t.db, { name: 'Target', domain: 'target.com' });
    await upsertCompanySource(t.db, { companyId: c.id, atsType: 'greenhouse', boardToken: 'target' });
    // The old board's last fetch succeeded but was empty.
    const run = await startPluginRun(t.db, { pluginId: 'source-greenhouse', stage: 'source', targetKey: 'greenhouse:target' });
    await finishPluginRun(t.db, run, { status: 'succeeded', itemsIn: 0, itemsOut: 0 });
    const keeper = await upsertCompany(t.db, { name: 'Stable', domain: 'stable.com' });
    await upsertCompanySource(t.db, { companyId: keeper.id, atsType: 'lever', boardToken: 'stable' });
    const run2 = await startPluginRun(t.db, { pluginId: 'source-lever', stage: 'source', targetKey: 'lever:stable' });
    await finishPluginRun(t.db, run2, { status: 'succeeded', itemsIn: 12, itemsOut: 12 });
    const pages = pagesFrom({
      'https://target.com/careers': { redirectTo: 'https://target.wd5.myworkdayjobs.com/targetcareers' },
      // Stable's site now also links a Workday board, but its Lever board still works: keep both.
      'https://stable.com/careers': { body: '<a href="https://stable.wd1.myworkdayjobs.com/External">jobs</a>' },
    });
    const now = new Date(Date.now() + 31 * DAY);
    const s = await runAtsRecheck({ db: t.db, pages, log: silentLogger, now: () => now }, config);
    expect(s).toMatchObject({ checked: 2, newSources: 2, staleSources: 1 });
    const rows = await t.db.execute<{ name: string; ats: string; token: string; status: string; detected_by: string | null }>(sql`
      select c.name, s.ats_type as ats, s.board_token as token, s.status, s.detected_by from company_sources s join companies c on c.id = s.company_id order by c.name, s.ats_type`);
    expect(rows.map((r) => [r.name, r.ats, r.token, r.status])).toEqual([
      ['Stable', 'lever', 'stable', 'active'],
      ['Stable', 'workday', 'stable.wd1/External', 'active'],
      ['Target', 'greenhouse', 'target', 'paused'],
      ['Target', 'workday', 'target.wd5/targetcareers', 'active'],
    ]);
    // Re-checked companies aren't checked again until recheckDays pass.
    expect((await runAtsRecheck({ db: t.db, pages, log: silentLogger, now: () => now }, config)).checked).toBe(0);
  });

  it('excluded companies are neither fetched nor re-checked', async () => {
    const c = await upsertCompany(t.db, { name: 'Nope', domain: 'nope.com' });
    await upsertCompanySource(t.db, { companyId: c.id, atsType: 'lever', boardToken: 'nope' });
    await setCompanyTags(t.db, c.id, ['excluded'], []);
    expect(await listSourceTargets(t.db, { companyName: 'Nope' })).toEqual([]);
    const s = await runAtsRecheck({ db: t.db, pages: pagesFrom({}), log: silentLogger }, config);
    expect(s.checked).toBe(0);
  });
});
