import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applicationDraftSchema,
  CONSENT_KEY,
  pluginManifestSchema,
  preferencesSchema,
  questionKey,
  UnansweredQuestionsError,
  UnknownLayoutError,
  type ApplicationDraft,
  type ApplyInput,
  type ApprovedDraft,
  type BrowserHandle,
} from '@jobforge/plugin-sdk';
import { fakeBrowser, fakeCredentials, fakeGmail, testContext } from '@jobforge/plugin-sdk/testing';
import plugin, { applyUrlFor, configSchema, taleoStep, type TaleoApplyConfig } from './index.js';

const fx = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url)), 'utf8');
const flow = (f: string) => fx(`flow/${f}.html`);
const LOGIN = fx('aa224-login.html'); // recorded
const JOB = 'https://aa224.taleo.net/careersection/ex/jobdetail.ftl?job=JR111341&lang=en';
const APPLY = 'https://aa224.taleo.net/careersection/ex/jobapply.ftl?job=JR111341&lang=en';
const ACCOUNT = 'aa224.taleo.net/aa224:me@gmail.com';
const Q_SHIFT = questionKey('Job-Specific Questions', 'Are you able to work rotating shifts?');

const config = (extra: Partial<TaleoApplyConfig> = {}) => {
  const tmp = mkdtempSync(join(tmpdir(), 'taleo-'));
  return configSchema.parse({ screenshotDir: join(tmp, 'shots'), failureDir: join(tmp, 'failures'), typingDelayMs: 0, ...extra });
};

const input = (): ApplyInput => ({
  job: { id: 'j1', companyId: 'c1', company: 'American Airlines', title: 'Yardspotter', normalizedTitle: 'yardspotter', locations: ['Dallas'], remotePolicy: null, seniority: null, descriptionMd: 'x', applyUrl: JOB, postedAt: null, embedding: null },
  ats: 'taleo',
  boardToken: 'aa224/ex',
  postingId: 'JR111341',
  applyUrl: JOB,
  profile: { version: 'v1', preferences: preferencesSchema.parse({}), facts: [], summary: '', embedding: null },
  applicant: preferencesSchema.parse({ application: { first_name: 'Divyansh', last_name: 'Parashar', email: 'me@gmail.com', phone: '7976398973', location: 'Bengaluru' } }).application!,
  resume: { path: '/tmp/resume.pdf', resumeVariantId: null },
});

const approve = (d: ApplicationDraft) => ({ reviewItemId: 'r1', draft: d }) as unknown as ApprovedDraft<ApplicationDraft>;

async function draft(cfg: TaleoApplyConfig, answers: Record<string, string> = { [CONSENT_KEY]: 'Yes', [Q_SHIFT]: 'Yes' }) {
  const d = await plugin.prepare(testContext(cfg), input());
  const extra = answers[Q_SHIFT]
    ? [{ key: Q_SHIFT, label: 'Are you able to work rotating shifts?', kind: 'select' as const, required: true, selectors: ['#q-shift'], options: ['Yes', 'No'], value: answers[Q_SHIFT]!, source: 'human' as const }]
    : [];
  const fields = [...d.fields.map((f) => (answers[f.key] ? { ...f, value: answers[f.key]!, source: 'human' as const } : f)), ...extra];
  return applicationDraftSchema.parse({ ...d, fields, missingRequired: fields.filter((f) => f.required && !f.value).map((f) => f.label) });
}

/** login → New User → register → emailed code → privacy agreement → 3 flow pages → Review and Submit. */
function newUserSite(gmail: ReturnType<typeof fakeGmail>, pages = ['resume-upload', 'general-profile', 'job-specific-questions', 'review']) {
  let i = -1;
  return fakeBrowser({
    pages: { [APPLY]: LOGIN },
    onClick(sel, cur) {
      if (sel === '#dialogTemplate-dialogForm-login-register') return { html: flow('register') };
      if (sel === '#dialogTemplate-dialogForm-defaultCmd') {
        gmail.receive({ threadId: 't', from: 'American Airlines <noreply@aa224.taleo.net>', subject: 'Verify your email', body: 'Your verification code is 731942.', at: new Date(Date.now() + 1000) });
        return { html: flow('verify-code') };
      }
      if (sel === '#dialogTemplate-dialogForm-verifyCmd') return { html: flow('legal-disclaimer') };
      if (sel === '#dialogTemplate-dialogForm-login-defaultCmd') return { html: flow('legal-disclaimer') };
      if (sel.includes('legalDisclaimerAcceptButton') || ((sel.includes('saveContinueCmdBottom') || sel.includes('Launch assessment')) && !cur.html.includes('submitCmdBottom'))) return { html: flow(pages[++i]!) };
      if (sel.includes('submitCmdBottom')) return { html: flow('submitted') };
      return undefined;
    },
  });
}

describe('actor-apply-taleo', () => {
  it('has a valid external manifest scoped to Taleo, Gmail read and keychain credentials', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.permissions).toMatchObject({ domains: ['*.taleo.net'], browser: true, gmail: ['read'], credentials: true });
  });

  it('turns the job URL into the jobapply URL the recorded redirect came from', () => {
    expect(applyUrlFor(JOB)).toBe(APPLY);
    expect(fx('aa224-jobapply-redirect.html')).toContain(encodeURIComponent(APPLY).replace(/%26/g, '%26'));
    expect(() => applyUrlFor('https://example.com/x')).toThrow(/not a Taleo job URL/);
  });

  it('reads flow page titles; the recorded login page is not a flow page', () => {
    expect(taleoStep(flow('general-profile'))).toBe('General Profile');
    expect(taleoStep(flow('review'))).toBe('Review and Submit');
    expect(taleoStep(LOGIN)).toBeNull();
    expect(taleoStep(flow('unknown'))).toBeNull();
    expect(taleoStep(flow('unknown'), ['Candidate Selection Assessment'])).toBe('Candidate Selection Assessment');
  });

  it('prepare: no network, profile answers, your consent still to give', async () => {
    const d = await plugin.prepare(testContext(config()), input());
    expect(d).toMatchObject({ ats: 'taleo', jobUrl: JOB, applyUrl: APPLY });
    expect(d.missingRequired).toEqual([expect.stringMatching(/I accept American Airlines's Taleo candidate account terms/)]);
    expect(Object.fromEntries(d.fields.map((f) => [f.key, f.value]))).toMatchObject({
      resume: '/tmp/resume.pdf',
      'general-profile:first_name': 'Divyansh',
      'general-profile:email': 'me@gmail.com',
      'general-profile:phone': '7976398973',
    });
  });

  it('dry run, new user: registers (keychain password), enters the emailed code, accepts the agreement, reaches Review and Submit, never submits', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const credentials = fakeCredentials();
    const browser = newUserSite(gmail);
    const cfg = config();
    const ctx = testContext(cfg, undefined, { browser: browser as BrowserHandle, dryRun: true, gmail, credentials });
    const r = await plugin.execute(ctx, approve(await draft(cfg)), 'k1');

    expect(r).toMatchObject({ dryRun: true, submitted: false });
    const pw = credentials.saved.get(ACCOUNT)!;
    expect(pw).toBeTruthy();
    const fills = browser.actions.filter((a) => a.type === 'fill' || a.type === 'type');
    const filled = (sel: string) => fills.filter((a) => a.selector === sel).map((a) => a.value);
    expect(filled('#dialogTemplate-dialogForm-userName')).toEqual(['me@gmail.com']);
    expect(filled('#dialogTemplate-dialogForm-password')).toEqual([pw]);
    expect(filled('#dialogTemplate-dialogForm-passwordConfirm')).toEqual([pw]);
    expect(filled('#dialogTemplate-dialogForm-emailConfirm')).toEqual(['me@gmail.com']);
    expect(filled('#dialogTemplate-dialogForm-verificationCode')).toEqual(['731942']);
    expect(filled('input[id$="personal_info_LastName"]')).toEqual(['Parashar']);
    expect(browser.actions.filter((a) => a.type === 'check').map((a) => a.selector)).toEqual(['#dialogTemplate-dialogForm-privacyAgreementAccepted']);
    expect(browser.actions.filter((a) => a.type === 'upload')).toEqual([expect.objectContaining({ selector: 'input[type="file"]', value: '/tmp/resume.pdf' })]);
    expect(browser.actions.filter((a) => a.type === 'select')).toEqual([expect.objectContaining({ selector: '#q-shift', value: 'Yes' })]);
    const clicks = browser.actions.filter((a) => a.type === 'click').map((a) => a.selector);
    expect(clicks).toContain('#et-ef-content-ftf-legalDisclaimerAcceptButton');
    expect(clicks.some((s) => s!.includes('submitCmdBottom'))).toBe(false);
    expect(r.screenshots.map((s) => s.split('/k1-')[1])).toEqual(['verify-email.png', 'agreement.png', 'resume-upload.png', 'general-profile.png', 'job-specific-questions.png', 'review.png']);
  });

  it('live, existing account: signs in on the recorded login page with the stored password and submits', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const browser = newUserSite(gmail);
    const cfg = config();
    const credentials = fakeCredentials({ [ACCOUNT]: 'Stored-Pw1!' });
    const ctx = testContext(cfg, undefined, { browser: browser as BrowserHandle, dryRun: false, gmail, credentials });
    const r = await plugin.execute(ctx, approve(await draft(cfg)), 'k2');
    expect(r).toMatchObject({ dryRun: false, submitted: true });
    expect(r.confirmation).toMatch(/Thank you for applying/);
    const fills = browser.actions.filter((a) => a.type === 'fill');
    expect(fills.slice(0, 2).map((a) => [a.selector, a.value])).toEqual([
      ['#dialogTemplate-dialogForm-login-name1', 'me@gmail.com'],
      ['#dialogTemplate-dialogForm-login-password', 'Stored-Pw1!'],
    ]);
    expect(credentials.saved.size).toBe(1);
    expect(browser.actions.filter((a) => a.type === 'click').at(-1)!.selector).toBe('#et-ef-content-ftf-submitCmdBottom');
  });

  it('without your consent it stops at the agreement (nothing created or accepted)', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const browser = newUserSite(gmail);
    const cfg = config();
    const credentials = fakeCredentials();
    const ctx = testContext(cfg, undefined, { browser: browser as BrowserHandle, dryRun: true, gmail, credentials });
    const d = applicationDraftSchema.parse({ ...(await draft(cfg, { [Q_SHIFT]: 'Yes' })), missingRequired: [] });
    const err = await plugin.execute(ctx, approve(d), 'k3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnansweredQuestionsError);
    expect((err as UnansweredQuestionsError).questions.map((q) => q.key)).toEqual([CONSENT_KEY]);
    expect(credentials.saved.size).toBe(0);
    expect(browser.actions.some((a) => a.type === 'check' || a.selector === '#dialogTemplate-dialogForm-defaultCmd')).toBe(false);
  });

  it('a page it does not recognise raises UnknownLayoutError with screenshots and a recorded failure', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const browser = newUserSite(gmail, ['resume-upload', 'unknown']);
    const events: Array<[string, Record<string, unknown>]> = [];
    const cfg = config();
    const ctx = testContext(cfg, undefined, { browser: browser as BrowserHandle, dryRun: true, gmail, credentials: fakeCredentials({ [ACCOUNT]: 'pw' }), emit: (k, d) => events.push([k, d]) });
    const err = await plugin.execute(ctx, approve(await draft(cfg)), 'k4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownLayoutError);
    const e = err as UnknownLayoutError;
    expect(e.message).toMatch(/could not tell which Taleo step is showing \(layout not recognised\)/);
    expect(e.screenshots).toEqual([expect.stringMatching(/agreement\.png$/), expect.stringMatching(/resume-upload\.png$/), expect.stringMatching(/unknown\.png$/)]);
    expect(events.map(([k, d]) => [k, d.tenant])).toEqual([['step_failed', 'aa224']]);
    expect(readFileSync(events[0]![1].html as string, 'utf8')).toContain('Candidate Selection Assessment');
  });

  it('a tenant override can name its own step titles', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const browser = newUserSite(gmail, ['resume-upload', 'unknown', 'review']);
    const cfg = config({ tenants: { aa224: { selectors: { next: ['a:has-text("Launch assessment")'] }, questions: [], steps: ['Candidate Selection Assessment'] } } } as Partial<TaleoApplyConfig>);
    const ctx = testContext(cfg, undefined, { browser: browser as BrowserHandle, dryRun: true, gmail, credentials: fakeCredentials({ [ACCOUNT]: 'pw' }) });
    // The assessment page has no Save and Continue; the override's selector moves on from it.
    const r = await plugin.execute(ctx, approve(await draft(cfg)), 'k5');
    expect(r).toMatchObject({ dryRun: true, submitted: false });
    expect(r.screenshots.at(-1)).toMatch(/review\.png$/);
  });
});
