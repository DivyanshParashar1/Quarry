import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAppConfig, preferencesSchema } from '@jobforge/shared';
import { fakeBrowser } from '@jobforge/plugin-sdk/testing';
import { applicationDraftSchema } from '@jobforge/plugin-sdk';
import {
  createReviewItem,
  getReviewItem,
  insertResumeVariant,
  listSourceTargets,
  sql,
  upsertCompany,
  upsertCompanySource,
} from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import greenhouseApply from '@jobforge/actor-apply-greenhouse';
import { formUrl, questionsUrl } from '@jobforge/actor-apply-greenhouse';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { approveReviewItem, editDraft } from './outreach.js';
import { applyKey, draftApplication, runApplyTick, type ApplyDeps } from './apply.js';
import { runSourceTarget } from './source-runner.js';
import { loadProfileData } from './profile-loader.js';
import { fakeClock, silentLogger } from './test-utils.js';
import { z } from 'zod';
import type { SourcePlugin } from '@jobforge/plugin-sdk';

const adminUrl = testDbAdminUrl();
const ghFixture = (f: string) => readFileSync(fileURLToPath(new URL(`../../../plugins/actor-apply-greenhouse/fixtures/${f}`, import.meta.url)), 'utf8');

/** A stand-in Greenhouse board source that yields the posting the apply actor targets. */
const ghSource: SourcePlugin = {
  manifest: { id: 'source-greenhouse', version: '0.0.1', stage: 'source', description: 'fake', configSchema: z.object({}), permissions: { domains: [] }, sideEffects: 'none' },
  async *fetch() {
    yield { externalId: '4012345', url: 'https://boards.greenhouse.io/acme/jobs/4012345', applyUrl: 'https://boards.greenhouse.io/acme/jobs/4012345', title: 'Software Engineer, New Grad', locations: ['Bengaluru'], remotePolicy: null, department: null, descriptionHtml: '<p>x</p>', postedAt: null, payload: {} };
  },
};

describe.skipIf(!adminUrl)('ATS apply (postgres)', () => {
  let t: TestDb;
  let deps: ApplyDeps;
  let jobId: string;
  let submitted = 0;
  const site = fakeBrowser({
    pages: { [formUrl('acme', '4012345')]: ghFixture('embed-form.html') },
    onClick: (s) => {
      if (s === '#submit_app') {
        submitted++;
        return { html: ghFixture('confirmation.html') };
      }
      return undefined;
    },
  });

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const config = parseAppConfig({ plugins: { 'actor-apply-greenhouse': { screenshotDir: mkdtempSync(join(tmpdir(), 'apply-')), typingDelayMs: 0 } } });
    const registry = new PluginRegistry();
    registry.register(greenhouseApply, config.plugins['actor-apply-greenhouse']);
    registry.register(ghSource);
    // The apply actor's question fetch goes through ScopedHttp; serve the fixture.
    const fetch = (async (input: URL | string) => {
      const url = String(input);
      if (url === questionsUrl('acme', '4012345')) return new Response(ghFixture('job-questions.json'), { headers: { 'content-type': 'application/json' } });
      return new Response('nope', { status: 404 });
    }) as typeof globalThis.fetch;
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(undefined, fakeClock()),
      fetch,
      dryRun: true,
      policy: config.outreach,
      openBrowser: async () => ({ newPage: () => site.newPage() }),
    };
    const c = await upsertCompany(t.db, { name: 'Acme' });
    await upsertCompanySource(t.db, { companyId: c.id, atsType: 'greenhouse', boardToken: 'acme' });
    const [row] = await listSourceTargets(t.db, { companyName: 'Acme' });
    await runSourceTarget(deps, row!);
    jobId = (await t.db.execute<{ id: string }>(sql`select id from jobs limit 1`))[0]!.id;
    await loadProfileData(
      t.db,
      [],
      preferencesSchema.parse({
        graduation_year: 2027,
        application: {
          first_name: 'Asha',
          last_name: 'Rao',
          email: 'asha@example.com',
          work_authorization: { India: 'yes' },
          requires_sponsorship: false,
          answers: [{ match: 'hear about', answer: 'Careers page' }],
        },
      }),
    );
  });
  afterAll(async () => t?.drop());

  it('refuses to draft without a tailored resume', async () => {
    await expect(draftApplication(deps, jobId)).rejects.toThrow(/tailor one first/);
  });

  it('drafts with a preview, needs the required answers before approval, then dry-runs without submitting', async () => {
    const version = (await t.db.execute<{ version: string }>(sql`select version from profile_snapshots limit 1`))[0]!.version;
    await insertResumeVariant(t.db, {
      jobId, profileVersion: version, pluginId: 'tailor-resume-latex', templateId: 't', factIds: [], bullets: {}, header: {}, validationReport: [],
      status: 'rendered', pdfPath: '/tmp/resume.pdf', pdfBytes: 1, provider: null, model: null, error: null, confidence: 0.9,
    });
    const item = await draftApplication(deps, jobId);
    const d = applicationDraftSchema.parse(item.draft);
    expect(item).toMatchObject({ kind: 'application', pluginId: 'actor-apply-greenhouse', status: 'pending' });
    expect(d.previewScreenshots).toHaveLength(1);
    expect(d.missingRequired).toEqual(['Why do you want to work at Acme?']);
    expect(d.profileVersion).toBe(version);
    await expect(approveReviewItem(t.db, deps.policy, item.id)).rejects.toThrow(/required questions/);
    await expect(draftApplication(deps, jobId)).rejects.toThrow(/already pending/);

    const edited = await editDraft(t.db, item.id, { fields: [{ key: 'question_55555', value: 'The payments platform.' }] });
    expect(applicationDraftSchema.parse(edited.draft).missingRequired).toEqual([]);
    await approveReviewItem(t.db, deps.policy, item.id);

    const dry = await runApplyTick(deps);
    expect(dry.outcomes).toEqual([expect.objectContaining({ ok: true, submitted: false })]);
    expect(submitted).toBe(0);
    expect((await getReviewItem(t.db, item.id))!.status).toBe('approved');
  });

  it('live: submits once with a screenshot trail; a retry or duplicate is a no-op', async () => {
    const live = { ...deps, dryRun: false };
    const r = await runApplyTick(live);
    expect(r.outcomes).toEqual([expect.objectContaining({ ok: true, submitted: true })]);
    expect(submitted).toBe(1);
    const [action] = await t.db.execute<{ idempotency_key: string; result: { screenshots: string[] } }>(sql`select idempotency_key, result from actions where dry_run = false`);
    const version = (await t.db.execute<{ version: string }>(sql`select version from profile_snapshots limit 1`))[0]!.version;
    expect(action!.idempotency_key).toBe(applyKey(jobId, version));
    expect(action!.result.screenshots).toHaveLength(2);

    // Nothing left to send.
    expect((await runApplyTick(live)).outcomes).toEqual([]);
    // A second (hand-made) item for the same job + profile returns the prior result without submitting again.
    const existing = (await t.db.execute<{ draft: unknown }>(sql`select draft from review_items where kind = 'application' limit 1`))[0]!.draft;
    const dup = await createReviewItem(t.db, { kind: 'application', pluginId: 'actor-apply-greenhouse', jobId, contactId: null, companyId: null, draft: existing as Record<string, unknown> });
    await approveReviewItem(t.db, deps.policy, dup.id);
    const again = await runApplyTick(live);
    expect(again.outcomes).toEqual([expect.objectContaining({ reviewItemId: dup.id, ok: true, submitted: true })]);
    expect(submitted).toBe(1);
    expect((await getReviewItem(t.db, dup.id))!).toMatchObject({ status: 'executed', error: 'already submitted earlier (not resubmitted)' });
    const ev = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from events where kind = 'application.submitted'`);
    expect(ev[0]!.n).toBe(2);
  });
});
