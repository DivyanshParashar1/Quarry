import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { sql, saveDiscoveredCompany, upsertCompany, findCompanyByDomain, listCompaniesForAtsCheck } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import type { LLMClient, LLMRequest } from '@jobforge/shared';
import { silentLogger } from '../test-utils.js';
import { RobotsDisallowedError, type PageFetcher, type PageResponse } from './page-fetcher.js';
import { runDiscoverCompanies } from './run.js';

const adminUrl = testDbAdminUrl();

function fakePages(routes: Record<string, Partial<PageResponse> & { redirectTo?: string; blocked?: boolean }>): PageFetcher {
  return {
    async get(url) {
      const r = routes[url];
      if (r?.blocked) throw new RobotsDisallowedError(url);
      if (r?.redirectTo) return { status: 200, url: r.redirectTo, chain: [url, r.redirectTo], body: '', contentType: 'text/html' };
      if (!r) return { status: 404, url, chain: [url], body: '', contentType: 'text/html' };
      return { status: r.status ?? 200, url, chain: [url], body: r.body ?? '', contentType: r.contentType ?? 'text/html' };
    },
  };
}

const YC = 'https://yc-oss.github.io/api/companies/all.json';
const ycBody = JSON.stringify([
  { name: 'Razorpay', website: 'https://razorpay.com', regions: ['India'], isHiring: true, status: 'Active', batch: 'W15' },
  { name: 'Zepto', website: 'https://www.zeptonow.com', regions: ['India'], isHiring: true, status: 'Active', batch: 'W21' },
  { name: 'Groww', website: 'https://groww.in', regions: ['India'], isHiring: true, status: 'Active' },
  { name: 'NotHiring', website: 'https://nh.com', regions: ['India'], isHiring: false, status: 'Active' },
  { name: 'US Only', website: 'https://us.com', regions: ['United States of America'], isHiring: true, status: 'Active' },
  { name: 'Dead Co', website: 'https://dead.com', regions: ['India'], isHiring: true, status: 'Inactive' },
  { name: 'Razorpay', website: 'https://razorpay.com/', regions: ['India'], isHiring: true, status: 'Active' }, // dup
]);

describe.skipIf(!adminUrl)('discover_companies (postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.execute(sql`truncate companies, company_sources, plugin_runs, events cascade`);
  });

  const pages = fakePages({
    [YC]: { body: ycBody, contentType: 'application/json' },
    'https://razorpay.com/careers': { redirectTo: 'https://jobs.lever.co/razorpay' },
    'https://zeptonow.com/careers': { body: '<a href="https://jobs.ashbyhq.com/zepto">Jobs</a>' },
    'https://groww.in/careers': { blocked: true },
  });

  it('adds new companies with detected boards, skips known ones, and is idempotent', async () => {
    await upsertCompany(t.db, { name: 'Groww Old Name', domain: 'www.groww.in' }); // known by domain
    const s = await runDiscoverCompanies({ db: t.db, pages, log: silentLogger }, { list: 'yc', concurrency: 2 });
    expect(s).toMatchObject({ candidates: 4, unique: 3, existing: 1, added: 2, withAts: 2, withoutAts: 0, errors: [] });

    const rows = await t.db.execute<{ name: string; ats: string; token: string; via: string; detected: string }>(sql`
      select c.name, s.ats_type as ats, s.board_token as token, c.discovered_via as via, s.detected_by as detected
      from companies c join company_sources s on s.company_id = c.id order by c.name`);
    expect(rows.map((r) => [r.name, r.ats, r.token, r.via, r.detected])).toEqual([
      ['Razorpay', 'lever', 'razorpay', 'list:yc', 'discover_ats'],
      ['Zepto', 'ashby', 'zepto', 'list:yc', 'discover_ats'],
    ]);
    const tags = await t.db.execute<{ tags: string[] }>(sql`select tags from companies where name = 'Razorpay'`);
    expect(tags[0]!.tags).toEqual(expect.arrayContaining(['startup', 'yc', 'yc-w15']));

    const again = await runDiscoverCompanies({ db: t.db, pages, log: silentLogger }, { list: 'yc' });
    expect(again).toMatchObject({ existing: 3, added: 0 });
    const n = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from companies`);
    expect(n[0]!.n).toBe(3);

    const runs = await t.db.execute<{ plugin_id: string; status: string }>(sql`select plugin_id, status from plugin_runs`);
    expect(runs.every((r) => r.plugin_id === 'discovery:yc' && r.status === 'succeeded')).toBe(true);
  });

  it('dry run detects but writes nothing', async () => {
    const s = await runDiscoverCompanies({ db: t.db, pages, log: silentLogger }, { list: 'yc', dryRun: true });
    expect(s.added).toBe(3);
    const n = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from companies`);
    expect(n[0]!.n).toBe(0);
  });

  it('extracts companies from a list page with the LLM', async () => {
    const GCC = 'https://gccjournal.in/insights/list-of-global-capability-centers-gcc-in-india/';
    const llmPages = fakePages({
      [GCC]: { body: '<h1>GCCs</h1><ul><li>Target India <a href="https://target.com">site</a></li><li>Lowe’s India</li></ul>' },
      'https://target.com/careers': { redirectTo: 'https://target.wd5.myworkdayjobs.com/targetcareers' },
    });
    const prompts: string[] = [];
    const llm: LLMClient = {
      async generate<T>(req: LLMRequest<T>) {
        prompts.push(req.prompt);
        const data = { companies: [{ name: 'Target', domain: 'target.com', location: 'Bengaluru' }, { name: "Lowe's India", domain: null, location: null }] };
        return { data: (req.schema as z.ZodType<T>).parse(data), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, provider: 'fake', model: 'fake' };
      },
    };
    const s = await runDiscoverCompanies({ db: t.db, pages: llmPages, llm, log: silentLogger }, { list: 'gcc-journal' });
    expect(prompts[0]).toContain('[target.com]'); // link hosts survive the HTML → text pass
    expect(s).toMatchObject({ unique: 2, added: 2, withAts: 1, withoutAts: 1 });
    const target = await findCompanyByDomain(t.db, 'target.com');
    expect(target?.name).toBe('Target');
    // the one without a board is due a re-check
    const due = await listCompaniesForAtsCheck(t.db, { checkedBefore: new Date(Date.now() + 1000), onlyWithoutSources: true });
    expect(due.map((d) => d.name)).toEqual(["Lowe's India"]);
  });

  it('saveDiscoveredCompany merges by domain and only fills blanks', async () => {
    await upsertCompany(t.db, { name: 'JPMorgan Chase', domain: 'jpmorganchase.com', location: 'Mumbai' });
    const r = await saveDiscoveredCompany(t.db, {
      name: 'JPMC India',
      domain: 'https://www.jpmorganchase.com/',
      location: 'Bengaluru',
      tags: ['gcc'],
      discoveredVia: 'list:gcc-journal',
      sources: [{ atsType: 'workday', boardToken: 'jpmc.wd5/External' }],
    });
    expect(r).toMatchObject({ companyCreated: false, matchedBy: 'domain', sourcesCreated: 1 });
    const [c] = await t.db.execute<{ name: string; location: string; tags: string[] }>(sql`select name, location, tags from companies`);
    expect(c).toMatchObject({ name: 'JPMorgan Chase', location: 'Mumbai', tags: ['gcc'] });
  });
});
