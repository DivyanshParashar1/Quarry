import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql, upsertCompany, upsertCompanySource, listSourceTargets, getState } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { fakeGmail } from '@jobforge/plugin-sdk/testing';
import gmailAlerts from '@jobforge/source-gmail-alerts';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { runAlertSource } from './alert-runner.js';
import { runSourceTarget } from './source-runner.js';
import { silentLogger } from './test-utils.js';
import type { SourcePlugin } from '@jobforge/plugin-sdk';
import { z } from 'zod';

const adminUrl = testDbAdminUrl();
const fixture = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../../../plugins/source-gmail-alerts/fixtures/${f}`, import.meta.url)), 'utf8');

/** A board source that yields the same Walmart role the LinkedIn alert mentions. */
const fakeBoard: SourcePlugin = {
  manifest: { id: 'source-workday', version: '0.0.1', stage: 'source', description: 'fake', configSchema: z.object({}), permissions: { domains: [] }, sideEffects: 'none' },
  async *fetch() {
    yield {
      externalId: 'R-1',
      url: 'https://walmart.wd5.myworkdayjobs.com/WalmartExternal/job/x_R-1',
      applyUrl: null,
      title: 'Software Engineer Intern - 2027',
      locations: ['Bengaluru, Karnataka, India'],
      remotePolicy: null,
      department: null,
      descriptionHtml: '<p>Build things</p>',
      postedAt: null,
      payload: {},
    };
  },
};

describe.skipIf(!adminUrl)('alert source runner (postgres)', () => {
  let t: TestDb;
  let registry: PluginRegistry;
  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    registry = new PluginRegistry();
    registry.register(gmailAlerts);
    registry.register(fakeBoard);
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.db.execute(sql`truncate companies, company_sources, jobs, raw_postings, plugin_runs, events, app_state cascade`);
  });

  it('matches employers to known companies, merges with board postings, records failures, advances the cursor', async () => {
    const walmart = await upsertCompany(t.db, { name: 'Walmart Global Tech' });
    await upsertCompanySource(t.db, { companyId: walmart.id, atsType: 'workday', boardToken: 'walmart.wd5/WalmartExternal' });
    const [row] = await listSourceTargets(t.db, { companyName: 'Walmart Global Tech' });
    const deps = { db: t.db, registry, log: silentLogger, limiter: new DomainRateLimiter(), dryRun: true };
    await runSourceTarget(deps, row!);

    const gmail = fakeGmail();
    gmail.receive({ threadId: 'a', from: 'jobalerts-noreply@linkedin.com', subject: 'Job alert', html: fixture('linkedin.html'), at: new Date() });
    gmail.receive({ threadId: 'b', from: 'jobalerts-noreply@linkedin.com', subject: 'Your job alert', html: fixture('linkedin-redesigned.html'), at: new Date() });

    const s = await runAlertSource({ ...deps, gmail });
    expect(s).toMatchObject({ ok: true, postings: 3, jobsCreated: 2, jobsUpdated: 1, companiesCreated: 2 });

    // The Walmart alert merged into the Workday job: one canonical job, two raw postings.
    const merged = await t.db.execute<{ n: number; c: string }>(sql`
      select count(r.*)::int as n, c.name as c from jobs j join companies c on c.id = j.company_id
      join raw_postings r on r.canonical_job_id = j.id where j.title = 'Software Engineer Intern - 2027' group by c.name`);
    expect(merged).toEqual([{ n: 2, c: 'Walmart Global Tech' }]);

    const created = await t.db.execute<{ name: string; via: string }>(sql`select name, discovered_via as via from companies where discovered_via = 'gmail-alert' order by name`);
    expect(created.map((c) => c.name)).toEqual(['Flipkart', 'Goldman Sachs']);

    const ev = await t.db.execute<{ kind: string }>(sql`select kind from events where kind like 'plugin.%'`);
    expect(ev.map((e) => e.kind)).toEqual(['plugin.source-gmail-alerts.parse_empty']);
    expect(await getState(t.db, 'source-gmail-alerts.cursor')).toMatchObject({ at: expect.any(String) });

    // Rerun: idempotent.
    const again = await runAlertSource({ ...deps, gmail });
    expect(again).toMatchObject({ ok: true, jobsCreated: 0, companiesCreated: 0 });
  });

  it('a Gmail failure fails the run without throwing', async () => {
    const gmail = fakeGmail();
    gmail.search = async () => {
      throw new Error('quota');
    };
    const s = await runAlertSource({ db: t.db, registry, log: silentLogger, limiter: new DomainRateLimiter(), dryRun: true, gmail });
    expect(s).toMatchObject({ ok: false, error: 'quota' });
    expect(await getState(t.db, 'source-gmail-alerts.cursor')).toBeNull();
  });
});
