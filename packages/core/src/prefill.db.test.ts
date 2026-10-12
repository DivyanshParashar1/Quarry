import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseAppConfig, preferencesSchema } from '@quarry/shared';
import { fakeBrowser } from '@quarry/plugin-sdk/testing';
import type { SourcePlugin } from '@quarry/plugin-sdk';
import { enterPipeline, getPipelineState, getReviewItem, insertResumeVariant, listReviewItems, listSourceTargets, sql, transitionPipeline, upsertCompany, upsertCompanySource } from '@quarry/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@quarry/db/testing';
import greenhouseApply, { formUrl, questionsUrl } from '@quarry/actor-apply-greenhouse';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { approveReviewItem } from './outreach.js';
import { draftApplication, runApplyTick, type ApplyDeps } from './apply.js';
import { openPrefilledForm } from './prefill.js';
import { runSourceTarget } from './source-runner.js';
import { loadProfileData } from './profile-loader.js';
import { fakeClock, silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();
const fx = (f: string) => readFileSync(fileURLToPath(new URL(`../../../plugins/actor-apply-greenhouse/fixtures/${f}`, import.meta.url)), 'utf8');

const ghSource: SourcePlugin = {
  manifest: { id: 'source-greenhouse', version: '0.0.1', stage: 'source', description: 'fake', configSchema: z.object({}), permissions: { domains: [] }, sideEffects: 'none' },
  async *fetch() {
    yield { externalId: '4012345', url: 'https://boards.greenhouse.io/acme/jobs/4012345', applyUrl: 'https://boards.greenhouse.io/acme/jobs/4012345', title: 'Software Engineer, New Grad', locations: ['Bengaluru'], remotePolicy: null, department: null, descriptionHtml: '<p>x</p>', postedAt: null, payload: {} };
  },
};

describe.skipIf(!adminUrl)('captcha hand-off + prefilled form (postgres)', () => {
  let t: TestDb;
  let deps: ApplyDeps;
  let jobId: string;
  let submitClicks = 0;
  // Submitting lands on a captcha instead of the confirmation.
  const site = fakeBrowser({
    pages: { [formUrl('acme', '4012345')]: fx('embed-form.html') },
    onClick: (s) => (s === '#submit_app' ? (submitClicks++, { html: fx('captcha.html') }) : undefined),
  });
  // The person's visible window: a separate browser that must never submit.
  const visible = fakeBrowser({ pages: { [formUrl('acme', '4012345')]: fx('embed-form.html') } });

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const config = parseAppConfig({ plugins: { 'actor-apply-greenhouse': { screenshotDir: mkdtempSync(join(tmpdir(), 'prefill-')), typingDelayMs: 0, confirmTimeoutMs: 0 } } });
    const registry = new PluginRegistry();
    registry.register(greenhouseApply, config.plugins['actor-apply-greenhouse']);
    registry.register(ghSource);
    const fetch = (async (input: URL | string) =>
      String(input) === questionsUrl('acme', '4012345') ? new Response(fx('job-questions.json'), { headers: { 'content-type': 'application/json' } }) : new Response('nope', { status: 404 })) as typeof globalThis.fetch;
    deps = { db: t.db, registry, log: silentLogger, limiter: new DomainRateLimiter(undefined, fakeClock()), fetch, dryRun: false, policy: config.outreach, openBrowser: async () => ({ newPage: () => site.newPage() }) };
    const c = await upsertCompany(t.db, { name: 'Acme' });
    await upsertCompanySource(t.db, { companyId: c.id, atsType: 'greenhouse', boardToken: 'acme' });
    const [row] = await listSourceTargets(t.db, { companyName: 'Acme' });
    await runSourceTarget(deps, row!);
    jobId = (await t.db.execute<{ id: string }>(sql`select id from jobs limit 1`))[0]!.id;
    await loadProfileData(t.db, [], preferencesSchema.parse({ application: { first_name: 'Asha', last_name: 'Rao', email: 'asha@example.com', work_authorization: { India: 'yes' }, requires_sponsorship: false, answers: [{ match: 'hear about', answer: 'Careers page' }, { match: 'why do you want', answer: 'Payments.' }] } }));
    const version = (await t.db.execute<{ version: string }>(sql`select version from profile_snapshots limit 1`))[0]!.version;
    await insertResumeVariant(t.db, { jobId, profileVersion: version, pluginId: 'tailor-resume-latex', templateId: 't', factIds: [], bullets: {}, header: {}, validationReport: [], status: 'rendered', pdfPath: '/tmp/resume.pdf', pdfBytes: 1, provider: null, model: null, error: null, confidence: 0.9 });
    await enterPipeline(t.db, jobId, {});
    await transitionPipeline(t.db, jobId, ['candidate'], 'ready_to_apply', 'test');
  });
  afterAll(async () => t?.drop());

  it('a captcha fails the application and hands it over with a prefill link; approving the hand-off marks the job applied', async () => {
    const app = await draftApplication(deps, jobId, { preview: false });
    await approveReviewItem(t.db, deps.policy, app.id);
    const r = await runApplyTick(deps);
    expect(r.outcomes).toEqual([expect.objectContaining({ ok: false })]);
    expect(submitClicks).toBe(1);
    expect((await getReviewItem(t.db, app.id))!.status).toBe('failed');

    const [handoff] = await listReviewItems(t.db, { kind: ['attention'], status: ['pending'], limit: 10 });
    expect(handoff!.draft).toMatchObject({ reason: 'captcha', applicationItemId: app.id, url: formUrl('acme', '4012345') });

    // "Open prefilled form" from the hand-off: the visible window gets every answer, and nothing is clicked.
    const opened = await openPrefilledForm({ db: t.db, openVisibleBrowser: async () => ({ newPage: () => visible.newPage() }) }, handoff!.id);
    expect(opened).toEqual({ url: formUrl('acme', '4012345'), notFound: [] });
    expect(visible.actions.filter((a) => a.type === 'fill').length).toBeGreaterThan(2);
    expect(visible.actions.some((a) => a.type === 'upload')).toBe(true);
    expect(visible.actions.some((a) => a.type === 'click')).toBe(false);

    await approveReviewItem(t.db, deps.policy, handoff!.id);
    expect((await getPipelineState(t.db, jobId))!.state).toBe('applied');
  });

  it('refuses to prefill an application that was already submitted', async () => {
    const [app] = await listReviewItems(t.db, { kind: ['application'], limit: 10 });
    await t.db.execute(sql`update review_items set status = 'executed' where id = ${app!.id}`);
    await expect(openPrefilledForm({ db: t.db, openVisibleBrowser: async () => ({ newPage: () => visible.newPage() }) }, app!.id)).rejects.toThrow(/already submitted/);
  });
});
