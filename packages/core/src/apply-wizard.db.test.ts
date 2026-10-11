import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseAppConfig, preferencesSchema } from '@jobforge/shared';
import { fakeBrowser, fakeCredentials, fakeGmail } from '@jobforge/plugin-sdk/testing';
import { applicationDraftSchema, type SourcePlugin } from '@jobforge/plugin-sdk';
import { getReviewItem, insertResumeVariant, listSourceTargets, sql, upsertCompany, upsertCompanySource } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import workdayApply from '@jobforge/actor-apply-workday';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { approveReviewItem } from './outreach.js';
import { draftApplication, runApplyTick, type ApplyDeps } from './apply.js';
import { runSourceTarget } from './source-runner.js';
import { loadProfileData } from './profile-loader.js';
import { fakeClock, silentLogger } from './test-utils.js';

// Phase 20: a Workday posting goes through the same review → approve → apply loop.

const adminUrl = testDbAdminUrl();
const fx = (f: string) => readFileSync(fileURLToPath(new URL(`../../../plugins/actor-apply-workday/fixtures/${f}`, import.meta.url)), 'utf8');
const JOB = 'https://workday.wd5.myworkdayjobs.com/Workday/job/INDPune/DataOps-Engineer_JR-0109475-1';
const DETAIL = 'https://workday.wd5.myworkdayjobs.com/wday/cxs/workday/Workday/job/INDPune/DataOps-Engineer_JR-0109475-1';

const wdSource: SourcePlugin = {
  manifest: { id: 'source-workday', version: '0.0.1', stage: 'source', description: 'fake', configSchema: z.object({}), permissions: { domains: [] }, sideEffects: 'none' },
  async *fetch() {
    yield { externalId: 'JR-0109475', url: JOB, applyUrl: JOB, title: 'DataOps Engineer', locations: ['Pune'], remotePolicy: null, department: null, descriptionHtml: '<p>x</p>', postedAt: null, payload: {} };
  },
};

describe.skipIf(!adminUrl)('Workday apply (postgres)', () => {
  let t: TestDb;
  let deps: ApplyDeps;
  let jobId: string;
  const credentials = fakeCredentials({ 'workday.wd5.myworkdayjobs.com/workday:me@gmail.com': 'Known-Passw0rd!' });
  const steps = ['my-information', 'my-experience', 'review'].map((s) => fx(`wizard/${s}.html`).replace(/<button aria-haspopup[\s\S]*?<\/div><\/div>/, ''));
  let i = -1;
  const site = fakeBrowser({
    pages: { [`${JOB}/apply/autofillWithResume`]: fx('wizard/sign-in.html') },
    onClick(s) {
      if (s.includes('signInSubmitButton')) return { html: fx('wizard/autofill.html') };
      if (s.includes(':has-text("Submit")')) throw new Error('a dry run must never submit');
      if (s.includes('bottom-navigation-next-button')) return { html: steps[++i]! };
      return undefined;
    },
  });

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const config = parseAppConfig({ plugins: { 'actor-apply-workday': { screenshotDir: mkdtempSync(join(tmpdir(), 'wd-')), failureDir: mkdtempSync(join(tmpdir(), 'wdf-')), typingDelayMs: 0, stepWaitMs: 0 } } });
    const registry = new PluginRegistry();
    registry.register(workdayApply, config.plugins['actor-apply-workday']);
    registry.register(wdSource);
    const fetch = (async (input: URL | string) =>
      String(input) === DETAIL ? new Response(fx('workday-detail.json'), { headers: { 'content-type': 'application/json' } }) : new Response('nope', { status: 404 })) as typeof globalThis.fetch;
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(undefined, fakeClock()),
      fetch,
      dryRun: true,
      policy: config.outreach,
      gmail: fakeGmail('me@gmail.com'),
      credentials: () => credentials,
      openBrowser: async () => ({ newPage: () => site.newPage() }),
    };
    const c = await upsertCompany(t.db, { name: 'Workday' });
    await upsertCompanySource(t.db, { companyId: c.id, atsType: 'workday', boardToken: 'workday.wd5/Workday' });
    const [row] = await listSourceTargets(t.db, { companyName: 'Workday' });
    await runSourceTarget(deps, row!);
    jobId = (await t.db.execute<{ id: string }>(sql`select id from jobs limit 1`))[0]!.id;
    await loadProfileData(t.db, [], preferencesSchema.parse({ application: { first_name: 'Asha', last_name: 'Rao', email: 'me@gmail.com', phone: '9999999999' } }));
    const version = (await t.db.execute<{ version: string }>(sql`select version from profile_snapshots limit 1`))[0]!.version;
    await insertResumeVariant(t.db, {
      jobId, profileVersion: version, pluginId: 'tailor-resume-latex', templateId: 't', factIds: [], bullets: {}, header: {}, validationReport: [],
      status: 'rendered', pdfPath: '/tmp/resume.pdf', pdfBytes: 1, provider: null, model: null, error: null, confidence: 0.9,
    });
  });
  afterAll(async () => t?.drop());

  it('drafts a Workday application (no preview), and an approved dry run reaches Review without submitting', async () => {
    const item = await draftApplication(deps, jobId);
    const d = applicationDraftSchema.parse(item.draft);
    expect(item).toMatchObject({ kind: 'application', pluginId: 'actor-apply-workday', status: 'pending' });
    expect(d).toMatchObject({ ats: 'workday', applyUrl: `${JOB}/apply/autofillWithResume`, previewScreenshots: [], missingRequired: [] });

    await approveReviewItem(t.db, deps.policy, item.id);
    const r = await runApplyTick(deps);
    expect(r.outcomes).toEqual([expect.objectContaining({ ok: true, submitted: false })]);
    expect(r.outcomes[0]!.screenshots!.at(-1)).toMatch(/review\.png$/);
    expect((await getReviewItem(t.db, item.id))!.status).toBe('approved');
    // The tenant password never reaches the database.
    const dump = await t.db.execute<{ j: string }>(sql`select (select coalesce(json_agg(e), '[]') from events e)::text || (select coalesce(json_agg(a), '[]') from actions a)::text || (select coalesce(json_agg(r), '[]') from review_items r)::text as j`);
    expect(dump[0]!.j).not.toContain('Known-Passw0rd!');
  });
});
