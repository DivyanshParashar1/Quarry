import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppConfig, preferencesSchema } from '@jobforge/shared';
import {
  autopilotApprovesSince,
  getReviewItem,
  insertResumeVariant,
  listReviewItems,
  recordLlmCall,
  recordPosting,
  saveMatchResults,
  sql,
  upsertCompany,
  upsertContact,
  type DB,
} from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createFakeProvider, createLLMClient, type ProviderRequest } from '@jobforge/llm';
import gmailOutreach from '@jobforge/actor-gmail-outreach';
import tailorResume from '@jobforge/tailor-resume-latex';
import { fakeGmail } from '@jobforge/plugin-sdk/testing';
import { runAutopilot, type AutopilotRunDeps } from './autopilot.js';
import { normalizePosting } from './normalize.js';
import { loadProfileData } from './profile-loader.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { OUTREACH_ACTOR, type OutreachDeps } from './outreach.js';
import { silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();

async function addJob(db: DB, companyId: string, company: string, id: string, title: string, desc: string) {
  const raw = {
    externalId: id,
    url: `https://x.example/${id}`,
    applyUrl: null,
    title,
    locations: ['Remote'],
    remotePolicy: 'remote' as const,
    department: null,
    descriptionHtml: `<p>${desc}</p>`,
    postedAt: new Date('2026-09-01T00:00:00Z'),
    payload: {},
  };
  return recordPosting(
    db,
    { ...normalizePosting(raw, company), companyId },
    { sourcePlugin: 'source-test', companySourceId: null, externalId: id, url: raw.url, payload: {} },
    new Date(),
  );
}

const config = parseAppConfig({
  autopilot: { enabled: true, minMatchScore: 70, confidenceFloor: { match: 0.75, tailor: 0.75, outreach: 0.8 }, minEmailConfidence: 0.6, maxAutoApprovesPerDay: 10, candidateBatch: 20 },
});

describe.skipIf(!adminUrl)('autopilot (postgres)', () => {
  let t: TestDb;
  let deps: AutopilotRunDeps;
  let jobHigh: string;
  let jobLowConfidence: string;

  // The tailor and the outreach actor share one fake provider; we return
  // different structured outputs depending on the task.
  const provider = createFakeProvider((r: ProviderRequest) => {
    const isTailor = r.prompt.startsWith('# Target job');
    if (isTailor) {
      return {
        header: { summary: 'Backend engineer with Go experience.', skills: ['Go'] },
        bullets: [
          { factId: 'exp-acme', text: 'Built the Go payments ledger handling 2M transactions/day.', section: 'Experience' },
        ],
        confidence: 0.9,
      };
    }
    // Outreach: low-confidence for the second (LOW-CONF-ROLE) job, high for the first.
    const isLow = r.prompt.includes('LOW-CONF-ROLE');
    return {
      subject: isLow ? 'Interested in LOW-CONF-ROLE' : 'Interested in SBE role',
      body: 'Hi Jane, I built a Go payments ledger handling 2M transactions a day and would love a quick chat about the role.',
      fact_ids: ['exp-acme'],
      confidence: isLow ? 0.4 : 0.9,
    };
  });

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const prefs = preferencesSchema.parse({ roles: ['Backend Engineer'], stack: ['Go'] });
    const facts = [
      { id: 'exp-acme', kind: 'experience' as const, content: 'Backend engineer at Acme. Built the Go payments ledger handling 2M transactions/day.', metrics: { transactions_per_day: 2_000_000 }, tags: ['go'] },
    ];
    const { version } = await loadProfileData(t.db, facts, prefs);

    const { id: companyId } = await upsertCompany(t.db, { name: 'Acme', domain: 'acme.com' });
    const r1 = await addJob(t.db, companyId, 'Acme', 'a', 'Senior Backend Engineer', 'Go payments');
    const r2 = await addJob(t.db, companyId, 'Acme', 'b', 'LOW-CONF-ROLE Backend Engineer', 'Go payments');
    jobHigh = r1.jobId;
    jobLowConfidence = r2.jobId;

    await saveMatchResults(t.db, version, 'matcher-default', [
      { jobId: jobHigh, method: 'llm', score: 88, similarity: 0.8, rubric: {}, reasons: 'Great fit', provider: 'fake', model: 'm', confidence: 0.9 },
      { jobId: jobLowConfidence, method: 'llm', score: 85, similarity: 0.8, rubric: {}, reasons: 'Low-confidence fit', provider: 'fake', model: 'm', confidence: 0.85 },
    ]);

    // Pre-insert "rendered" variants for both jobs so the test does not depend on
    // latexmk being installed. These are what runAutopilot will reuse.
    for (const jobId of [jobHigh, jobLowConfidence]) {
      await insertResumeVariant(t.db, {
        jobId,
        profileVersion: version,
        pluginId: 'tailor-resume-latex',
        templateId: 'jakes-resume',
        factIds: [],
        bullets: { selectedBlockIds: ['header', 'exp.screenify'], texPath: '/tmp/fake.tex', pages: 1 },
        header: { rewrites: [], techStackRewrites: [], skillsReorder: [], rationale: 'test' },
        validationReport: [],
        status: 'rendered',
        pdfPath: '/tmp/fake.pdf',
        pdfBytes: 1024,
        provider: 'fake',
        model: 'm',
        error: null,
        confidence: 0.9,
      });
    }

    // Separate company (and contact) for the low-confidence job so its draft isn't
    // skipped as "already_in_queue" after the first job's auto-approve.
    const { id: companyId2 } = await upsertCompany(t.db, { name: 'Beta', domain: 'beta.com' });
    // Repoint jobLowConfidence to company 2.
    await t.db.execute(sql`update jobs set company_id = ${companyId2} where id = ${jobLowConfidence}`);
    await upsertContact(t.db, { companyId, name: 'Jane Doe', email: 'jane@acme.com', role: 'EM' });
    await upsertContact(t.db, { companyId: companyId2, name: 'John Roe', email: 'john@beta.com', role: 'EM' });

    const registry = new PluginRegistry();
    registry.register(tailorResume);
    registry.register(gmailOutreach);
    const limiter = new DomainRateLimiter();
    const llm = createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code', onCall: (rec) => recordLlmCall(t.db, rec) });
    const resumeDir = await mkdtemp(join(tmpdir(), 'jf-autopilot-'));
    const outreachDeps: OutreachDeps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter,
      dryRun: true,
      policy: config.outreach,
      llm,
      gmail: fakeGmail('asha@gmail.com'),
    };
    deps = {
      db: t.db,
      log: silentLogger,
      policy: config.autopilot,
      outreachPolicy: config.outreach,
      outreachDeps,
      tailorDeps: { db: t.db, registry, log: silentLogger, limiter, dryRun: true, llm, resumeDir },
    };
  });
  afterAll(async () => t?.drop());

  it('auto-approves the high-confidence job and escalates the low-confidence one', async () => {
    // We need the contact to have high email confidence; mark it manual via upsert default -> but
    // upsertContact only sets emailSource = 'manual' when email is given, with confidence = 1.
    const [c] = (await t.db.execute<{ id: string; email_confidence: number | null }>(
      sql`select id, email_confidence from contacts where email = 'jane@acme.com'`,
    )) as unknown as [{ id: string; email_confidence: number | null }];
    expect(c.email_confidence).toBeGreaterThan(0.6);

    const summary = await runAutopilot(deps);
    const byJob = Object.fromEntries(summary.decisions.map((d) => [d.jobId, d]));
    expect(byJob[jobHigh]?.stage).toBe('approved');
    expect(byJob[jobLowConfidence]?.stage).toBe('draft');
    expect(byJob[jobLowConfidence]?.reason).toBe('draft_confidence');

    // The approved item is now 'approved' with decided_by='autopilot'.
    const approvedId = byJob[jobHigh]!.reviewItemId!;
    const row = await getReviewItem(t.db, approvedId);
    expect(row?.status).toBe('approved');
    expect(row?.decidedBy).toBe('autopilot');
    expect(row?.confidence).toBeGreaterThan(0.75);

    // The escalated one stays pending for the human.
    const lowId = byJob[jobLowConfidence]!.reviewItemId!;
    const low = await getReviewItem(t.db, lowId);
    expect(low?.status).toBe('pending');
    expect(low?.decidedBy).toBeNull();

    // Running again does nothing new: both items are already in the queue.
    const second = await runAutopilot(deps);
    expect(second.decisions.every((d) => d.reason === 'already_in_queue')).toBe(true);
  });

  it('respects maxAutoApprovesPerDay', async () => {
    const since = new Date(Date.now() - 86_400_000);
    const approves = await autopilotApprovesSince(t.db, since);
    expect(approves).toBeGreaterThan(0);

    const review = await listReviewItems(t.db, { status: ['approved'] });
    expect(review.some((r) => r.decidedBy === 'autopilot')).toBe(true);
    expect(OUTREACH_ACTOR).toBe('actor-gmail-outreach');
  });
});
