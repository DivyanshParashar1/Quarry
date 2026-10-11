import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseAppConfig, preferencesSchema } from '@jobforge/shared';
import {
  applicationDraftSchema,
  defineActorPlugin,
  draftConfidence,
  mapAnswers,
  OtpTimeoutError,
  UnansweredQuestionsError,
  type ApplicationDraft,
  type ApplicationResult,
  type ApplyInput,
  type FormQuestion,
} from '@jobforge/plugin-sdk';
import {
  getReviewItem,
  insertResumeVariant,
  listAnswerBank,
  listReviewItems,
  recordPosting,
  transitionReviewItem,
  upsertCompany,
  upsertCompanySource,
} from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createFakeProvider, createLLMClient, type ProviderRequest } from '@jobforge/llm';
import { draftApplication, runApplyTick, type ApplyDeps } from './apply.js';
import { normalizePosting } from './normalize.js';
import { approveReviewItem, editDraft } from './outreach.js';
import { loadProfileData } from './profile-loader.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();

const QUESTIONS: FormQuestion[] = [
  { key: 'first_name', label: 'First name', kind: 'text', required: true, selectors: ['#first_name'] },
  { key: 'why', label: 'Why do you want to work at Acme?', kind: 'textarea', required: true, selectors: ['#why'], maxLength: 600 },
  { key: 'years_go', label: 'How many years of Go experience do you have?', kind: 'select', required: true, selectors: ['#years'], options: ['Less than 1', '1-2', '3-5', '5+'] },
  { key: 'achievement', label: 'Describe your biggest professional achievement', kind: 'textarea', required: true, selectors: ['#ach'] },
  { key: 'salary', label: 'Expected salary (CTC)', kind: 'text', required: true, selectors: ['#ctc'] },
];

/** What the stub actor's execute() does next. */
const next: { throw: Error | null } = { throw: null };

const stubActor = defineActorPlugin<Record<string, never>, ApplyInput, ApplicationDraft, ApplicationResult>({
  manifest: { id: 'actor-apply-greenhouse', version: '0.0.1', stage: 'actor', description: 'stub', configSchema: z.object({}).default({}), permissions: { domains: [] }, sideEffects: 'external' },
  async prepare(_ctx, input) {
    const { fields, missingRequired } = mapAnswers(QUESTIONS, input);
    return applicationDraftSchema.parse({
      channel: 'apply', ats: 'greenhouse', title: input.job.title, company: input.job.company,
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1', applyUrl: 'https://boards.greenhouse.io/embed/job_app?for=acme&token=1',
      resumePath: input.resume.path, resumeVariantId: input.resume.resumeVariantId, fields, missingRequired, confidence: draftConfidence(fields),
    });
  },
  async execute() {
    if (next.throw) throw next.throw;
    return { dryRun: false, submitted: true, confirmation: 'Thank you for applying', screenshots: [], at: new Date().toISOString() };
  },
});

const prompts: string[] = [];
const provider = createFakeProvider((r: ProviderRequest) => {
  prompts.push(r.prompt);
  const answers = [];
  if (r.prompt.includes('key: why')) answers.push({ key: 'why', answer: 'I built a Go ledger service handling 2M tx/day, and Acme builds payment APIs, which is the work I want to keep doing.', confidence: 0.9, fact_ids: ['exp-ledger'] });
  if (r.prompt.includes('key: years_go')) answers.push({ key: 'years_go', answer: '1-2', confidence: 0.86, fact_ids: ['exp-ledger'] });
  if (r.prompt.includes('key: achievement')) answers.push({ key: 'achievement', answer: 'I led a team of 12 engineers at Google to ship a payments platform.', confidence: 0.95, fact_ids: ['exp-ledger'] });
  if (r.prompt.includes('key: q:embedded')) answers.push({ key: 'q:embedded', answer: null, confidence: 0.2, fact_ids: [] });
  return { answers };
});

describe.skipIf(!adminUrl)('application answers (postgres)', () => {
  let t: TestDb;
  let deps: ApplyDeps;
  const ids: Record<string, string> = {};
  const config = parseAppConfig({});

  async function addJob(externalId: string, title: string): Promise<string> {
    const raw = { externalId, url: `https://boards.greenhouse.io/acme/jobs/${externalId}`, applyUrl: null, title, locations: ['Bengaluru'], remotePolicy: null, department: null, descriptionHtml: '<p>We build payment APIs in Go.</p>', postedAt: null, payload: {} };
    const jobId = (await recordPosting(t.db, { ...normalizePosting(raw, 'Acme'), companyId: ids.company! }, { sourcePlugin: 'source-greenhouse', companySourceId: ids.source!, externalId, url: raw.url, payload: {} }, new Date())).jobId;
    await insertResumeVariant(t.db, { jobId, profileVersion: 'x', pluginId: 'tailor-resume-latex', templateId: 't', factIds: [], bullets: {}, header: {}, validationReport: [], status: 'rendered', pdfPath: '/tmp/resume.pdf', pdfBytes: 1, provider: null, model: null, error: null, confidence: 1 });
    return jobId;
  }

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const registry = new PluginRegistry();
    registry.register(stubActor);
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(),
      dryRun: false,
      llm: createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' }),
      policy: config.outreach,
      openBrowser: async () => ({ newPage: async () => { throw new Error('no browser'); } }),
    };
    await loadProfileData(
      t.db,
      [{ id: 'exp-ledger', kind: 'experience', content: 'Built a Go ledger service handling 2M tx/day at Screenify', metrics: {}, tags: [] }],
      preferencesSchema.parse({ roles: ['Backend Engineer'], application: { first_name: 'Divyansh', last_name: 'Parashar', email: 'me@example.com' } }),
    );
    ids.company = (await upsertCompany(t.db, { name: 'Acme' })).id;
    ids.source = (await upsertCompanySource(t.db, { companyId: ids.company, atsType: 'greenhouse', boardToken: 'acme' })).id;
    ids.job1 = await addJob('1', 'Backend Engineer');
    ids.job2 = await addJob('2', 'Platform Engineer');
  });
  afterAll(async () => t?.drop());

  it('answers free-text and choice questions from facts, rejects an invented fact, never asks about salary', async () => {
    const item = await draftApplication(deps, ids.job1!, { preview: false });
    const d = applicationDraftSchema.parse(item.draft);
    const f = Object.fromEntries(d.fields.map((x) => [x.key, x]));
    expect(f.first_name).toMatchObject({ value: 'Divyansh', source: 'profile' });
    expect(f.why).toMatchObject({ source: 'llm', confidence: 0.9 });
    expect(f.why!.value).toMatch(/Go ledger service/);
    expect(f.years_go).toMatchObject({ value: '1-2', source: 'llm' });
    expect(f.achievement).toMatchObject({ value: null, source: null });
    expect(f.achievement!.note).toMatch(/LLM answer rejected: number "12"/);
    expect(f.salary!.value).toBeNull();
    expect(prompts.at(-1)).not.toMatch(/salary/i);
    expect(d.missingRequired.sort()).toEqual(['Describe your biggest professional achievement', 'Expected salary (CTC)']);
    expect(d.confidence).toBe(0.6); // 3/5 required answered, capped by the LLM's 0.86
    ids.item1 = item.id;
  });

  it('your approval stores the answers (not salary) in the bank; the next form reuses them without the LLM', async () => {
    await editDraft(t.db, ids.item1!, { fields: [{ key: 'achievement', value: 'Shipped the Go ledger service at Screenify.' }, { key: 'salary', value: '12 LPA' }] });
    await approveReviewItem(t.db, config.outreach, ids.item1!);
    // Out of the way of the apply ticks below (they take the oldest approval first).
    await transitionReviewItem(t.db, ids.item1!, ['approved'], 'cancelled');
    const bank = await listAnswerBank(t.db);
    expect(bank.map((b) => [b.question, b.kind, b.origin]).sort()).toEqual([
      ['Describe your biggest professional achievement', 'text', 'human'],
      ['How many years of Go experience do you have?', 'choice', 'llm'],
      ['Why do you want to work at Acme?', 'text', 'llm'],
    ]);

    const before = prompts.length;
    const item = await draftApplication(deps, ids.job2!, { preview: false });
    const f = Object.fromEntries(applicationDraftSchema.parse(item.draft).fields.map((x) => [x.key, x]));
    expect(f.why).toMatchObject({ source: 'bank', confidence: 1 });
    expect(f.years_go).toMatchObject({ source: 'bank', value: '1-2' });
    expect(f.achievement).toMatchObject({ source: 'bank', value: 'Shipped the Go ledger service at Screenify.' });
    expect(prompts.length).toBe(before); // every open question came from the bank
    expect((await listAnswerBank(t.db)).find((b) => b.kind === 'choice')!.uses).toBe(1);
    ids.item2 = item.id;
  });

  it('questions that appear after "Next" send the application back for review, answered where possible', async () => {
    await editDraft(t.db, ids.item2!, { fields: [{ key: 'salary', value: '12 LPA' }] });
    await approveReviewItem(t.db, config.outreach, ids.item2!);
    next.throw = new UnansweredQuestionsError([{ key: 'q:embedded', label: 'Describe your embedded C experience', kind: 'textarea', required: true, selectors: ['#emb'] }]);
    const r = await runApplyTick(deps);
    next.throw = null;
    expect(r.outcomes[0]).toMatchObject({ ok: false });
    const item = (await getReviewItem(t.db, ids.item2!))!;
    expect(item.status).toBe('pending');
    expect(item.error).toMatch(/asked 1 more question/);
    const d = applicationDraftSchema.parse(item.draft);
    expect(d.fields.find((f) => f.key === 'q:embedded')).toMatchObject({ value: null, required: true });
    expect(d.missingRequired).toEqual(['Describe your embedded C experience']);
  });

  it('a verification email that never arrives fails the item and raises an attention item', async () => {
    await editDraft(t.db, ids.item2!, { fields: [{ key: 'q:embedded', value: 'None professionally; I have written C in coursework.' }] });
    await approveReviewItem(t.db, config.outreach, ids.item2!);
    next.throw = new OtpTimeoutError(['greenhouse-mail.io'], 300_000);
    await runApplyTick(deps);
    next.throw = null;
    expect((await getReviewItem(t.db, ids.item2!))!.status).toBe('failed');
    const attention = (await listReviewItems(t.db, { kind: ['attention'] })).find((a) => a.jobId === ids.job2);
    expect(attention!.draft).toMatchObject({ reason: 'otp_timeout', url: 'https://boards.greenhouse.io/embed/job_app?for=acme&token=1' });
  });
});
