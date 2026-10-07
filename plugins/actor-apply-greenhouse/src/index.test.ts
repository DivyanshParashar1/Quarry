import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applicationSchema, preferencesSchema } from '@jobforge/shared';
import {
  applicationDraftSchema,
  chooseOption,
  pluginManifestSchema,
  SessionBlockedError,
  type ApplicationDraft,
  type ApprovedDraft,
  type ApplyInput,
  type BrowserHandle,
} from '@jobforge/plugin-sdk';
import { fakeBrowser, fixtureHttp, testContext } from '@jobforge/plugin-sdk/testing';
import plugin, { configSchema, formUrl, questionsUrl } from './index.js';

const fx = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url)), 'utf8');
const domains = plugin.manifest.permissions.domains;
const dir = () => mkdtempSync(join(tmpdir(), 'gh-apply-'));

const applicant = applicationSchema.parse({
  first_name: 'Asha',
  last_name: 'Rao',
  email: 'asha@example.com',
  phone: '+91 9800000000',
  linkedin_url: 'https://www.linkedin.com/in/asha/',
  work_authorization: { India: 'yes' },
  requires_sponsorship: false,
  answers: [{ match: 'hear about', answer: 'Company careers page' }],
  eeo: { gender: 'decline' },
});

const input = (o: Partial<ApplyInput> = {}): ApplyInput => ({
  job: { id: 'j1', companyId: 'c1', company: 'Acme', title: 'Software Engineer, New Grad', normalizedTitle: 'x', locations: ['Bengaluru'], remotePolicy: null, seniority: null, descriptionMd: null, applyUrl: 'https://boards.greenhouse.io/acme/jobs/4012345', postedAt: null, embedding: null },
  ats: 'greenhouse',
  boardToken: 'acme',
  postingId: '4012345',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/4012345',
  profile: { version: 'v1', preferences: preferencesSchema.parse({ graduation_year: 2027 }), facts: [], summary: '', embedding: null },
  applicant,
  resume: { path: '/tmp/resume.pdf', resumeVariantId: null },
  ...o,
});

async function prepared(o: Partial<ApplyInput> = {}): Promise<ApplicationDraft> {
  const http = fixtureHttp({ [questionsUrl('acme', '4012345')]: { text: fx('job-questions.json'), contentType: 'application/json' } }, domains);
  return plugin.prepare(testContext(configSchema.parse({}), http), input(o));
}
const approve = (d: ApplicationDraft) => ({ reviewItemId: 'r1', draft: d }) as unknown as ApprovedDraft<ApplicationDraft>;

function site(after = 'confirmation.html') {
  return fakeBrowser({
    pages: { [formUrl('acme', '4012345')]: fx('embed-form.html') },
    onClick: (sel) => (sel === '#submit_app' ? { html: fx(after) } : undefined),
  });
}

describe('answer mapping', () => {
  it('chooses options by equality, prefix, then substring', () => {
    expect(chooseOption('yes', ['Yes', 'No'])).toBe('Yes');
    expect(chooseOption('no', ['No, I am not', 'Yes'])).toBe('No, I am not');
    expect(chooseOption('maybe', ['Yes', 'No'])).toBeNull();
  });
});

describe('actor-apply-greenhouse', () => {
  it('has a valid external manifest', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.sideEffects).toBe('external');
  });

  it('maps the form from the profile only, flags what it cannot answer', async () => {
    const d = await prepared();
    const v = Object.fromEntries(d.fields.map((f) => [f.label, f.value]));
    expect(v).toMatchObject({
      'First Name': 'Asha',
      'Last Name': 'Rao',
      Email: 'asha@example.com',
      Phone: '+91 9800000000',
      'Resume/CV': '/tmp/resume.pdf',
      'LinkedIn Profile': 'https://www.linkedin.com/in/asha/',
      'Are you legally authorized to work in India?': 'Yes',
      'Will you now or in the future require visa sponsorship?': 'No',
      'How did you hear about this job?': 'Company careers page',
      'Why do you want to work at Acme?': null, // never invented
      Gender: 'Decline To Self Identify', // "decline" picks the decline option
      'Veteran Status': null, // not set → left for the human
      'Cover Letter': null,
    });
    expect(d.missingRequired).toEqual(['Why do you want to work at Acme?']);
    expect(d.confidence).toBe(0.88); // 7 of 8 required answered
    expect(d.applyUrl).toBe(formUrl('acme', '4012345'));
    expect(d.fields.find((f) => f.key === 'resume')!.selectors[0]).toBe('input[type="file"]#resume');
  });

  it('refuses to execute while a required answer is missing', async () => {
    const d = await prepared();
    await expect(plugin.execute(testContext(configSchema.parse({ screenshotDir: dir() }), undefined, { browser: site() as BrowserHandle, dryRun: false }), approve(d), 'apply:j1:v1')).rejects.toThrow(/unanswered/);
  });

  function complete(d: ApplicationDraft): ApplicationDraft {
    return applicationDraftSchema.parse({
      ...d,
      fields: d.fields.map((f) => (f.key === 'question_55555' ? { ...f, value: 'I like the payments platform.', source: 'human' } : f)),
      missingRequired: [],
    });
  }

  it('dry run fills and screenshots but never clicks submit', async () => {
    const browser = site();
    const out = dir();
    const r = await plugin.execute(testContext(configSchema.parse({ screenshotDir: out, typingDelayMs: 0 }), undefined, { browser: browser as BrowserHandle, dryRun: true }), approve(complete(await prepared())), 'apply:j1:v1');
    expect(r).toMatchObject({ dryRun: true, submitted: false });
    expect(r.screenshots).toHaveLength(1);
    expect(existsSync(r.screenshots[0]!)).toBe(true);
    expect(browser.actions.some((a) => a.type === 'click')).toBe(false);
    expect(browser.actions.find((a) => a.type === 'upload')).toMatchObject({ selector: 'input[type="file"]#resume', value: '/tmp/resume.pdf' });
    expect(browser.actions.filter((a) => a.type === 'select').map((a) => a.value)).toEqual(['Yes', 'No', 'Decline To Self Identify']);
  });

  it('live: submits, detects the confirmation, keeps the screenshot trail', async () => {
    const browser = site();
    const r = await plugin.execute(testContext(configSchema.parse({ screenshotDir: dir(), typingDelayMs: 0 }), undefined, { browser: browser as BrowserHandle, dryRun: false }), approve(complete(await prepared())), 'apply:j1:v1');
    expect(r).toMatchObject({ dryRun: false, submitted: true });
    expect(r.confirmation).toMatch(/Thank you for applying/i);
    expect(r.screenshots.map((s) => s.split('/').pop())).toEqual(['apply_j1_v1-filled.png', 'apply_j1_v1-after-submit.png']);
    expect(browser.actions.filter((a) => a.type === 'click').map((a) => a.selector)).toEqual(['#submit_app']);
  });

  it('a captcha after submit hands over to a human', async () => {
    const browser = site('captcha.html');
    await expect(
      plugin.execute(testContext(configSchema.parse({ screenshotDir: dir(), typingDelayMs: 0, confirmTimeoutMs: 0 }), undefined, { browser: browser as BrowserHandle, dryRun: false }), approve(complete(await prepared())), 'apply:j1:v2'),
    ).rejects.toBeInstanceOf(SessionBlockedError);
  });

  it('preview returns screenshots without submitting', async () => {
    const browser = site();
    const shots = await plugin.preview!(testContext(configSchema.parse({ screenshotDir: dir() }), undefined, { browser: browser as BrowserHandle }), complete(await prepared()));
    expect(shots).toHaveLength(1);
    expect(browser.actions.some((a) => a.type === 'click')).toBe(false);
  });
});
