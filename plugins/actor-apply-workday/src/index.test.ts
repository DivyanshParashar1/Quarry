import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applicationDraftSchema,
  detailApiUrl,
  parseWorkdayToken,
  pluginManifestSchema,
  preferencesSchema,
  SessionBlockedError,
  UnansweredQuestionsError,
  type ApplicationDraft,
  type ApplyInput,
  type ApprovedDraft,
  type BrowserHandle,
} from '@jobforge/plugin-sdk';
import { fakeBrowser, fakeCredentials, fakeGmail, fixtureHttp, testContext } from '@jobforge/plugin-sdk/testing';
import { CONSENT_KEY, UnknownLayoutError } from '@jobforge/plugin-sdk';
import plugin, { activeStep, applyUrlFor, configSchema, externalPath, listboxFields, questionKey, type WorkdayApplyConfig } from './index.js';

const fx = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const page = (f: string) => readFileSync(fx(`wizard/${f}.html`), 'utf8');
const DOMAINS = ['*.myworkdayjobs.com', '*.myworkdaysite.com', '*.myworkday.com'];

// Tenant A: workday.wd5 (own host), no account yet, resume autofill, all six steps.
const A_TOKEN = 'workday.wd5/Workday';
const A_JOB = 'https://workday.wd5.myworkdayjobs.com/Workday/job/INDPune/DataOps-Engineer_JR-0109475-1';
const A_APPLY = `${A_JOB}/apply/autofillWithResume`;
// Tenant B: Wells Fargo on the shared myworkdaysite host, existing account, "Apply Manually",
// its own Next button and two questions learned from an earlier failure; no Self Identify step.
const B_TOKEN = 'wd1.myworkdaysite.com/wf/WellsFargoJobs';
const B_JOB = 'https://wd1.myworkdaysite.com/recruiting/wf/WellsFargoJobs/job/Bengaluru-India/Principal-Engineer_R-564508-1';
const B_APPLY = `${B_JOB}/apply/applyManually`;
const B_NEXT = 'button[data-automation-id="pageFooterNextButton"]';

const Q_SOURCE = questionKey('My Information', 'How did you hear about us?');
const Q_YEARS = questionKey('Application Questions', 'How many years of professional software experience do you have?');
const Q_RELOCATE = questionKey('Application Questions', 'Are you willing to relocate?');
const Q_GENDER = questionKey('Voluntary Disclosures', 'Gender');
const Q_TERMS = questionKey('Voluntary Disclosures', 'I have read and agree to the terms and conditions');

const tenantB = {
  selectors: { next: [B_NEXT] },
  autofill: false,
  questions: [
    { step: 'Application Questions', label: 'How many years of professional software experience do you have?', kind: 'text' as const, selector: '#q-years', required: true },
    { step: 'Application Questions', label: 'Are you willing to relocate?', kind: 'select' as const, selector: 'button[id="q-relocate"]', required: true },
  ],
};

const config = (extra: Partial<WorkdayApplyConfig> = {}) => {
  const tmp = mkdtempSync(join(tmpdir(), 'wd-'));
  return configSchema.parse({ screenshotDir: join(tmp, 'shots'), failureDir: join(tmp, 'failures'), tenants: { wf: tenantB }, ...extra });
};

const http = () =>
  fixtureHttp(
    {
      [detailApiUrl(parseWorkdayToken(A_TOKEN), externalPath(A_JOB))]: { file: fx('workday-detail.json') },
      [detailApiUrl(parseWorkdayToken(B_TOKEN), externalPath(B_JOB))]: { file: fx('wf-detail.json') },
    },
    DOMAINS,
  );

const input = (boardToken: string, applyUrl: string, title: string): ApplyInput => ({
  job: { id: 'j1', companyId: 'c1', company: 'Acme', title, normalizedTitle: title.toLowerCase(), locations: ['Pune'], remotePolicy: null, seniority: null, descriptionMd: 'Data pipelines', applyUrl, postedAt: null, embedding: null },
  ats: 'workday',
  boardToken,
  postingId: 'JR-1',
  applyUrl,
  profile: { version: 'v1', preferences: preferencesSchema.parse({}), facts: [], summary: '', embedding: null },
  applicant: preferencesSchema.parse({
    application: { first_name: 'Divyansh', last_name: 'Parashar', email: 'me@gmail.com', phone: '7976398973', location: 'Bengaluru', linkedin_url: 'https://linkedin.com/in/divyansh1212', eeo: { gender: 'Male' } },
  }).application!,
  resume: { path: '/tmp/resume.pdf', resumeVariantId: null },
});
const inputA = () => input(A_TOKEN, A_JOB, 'DataOps Engineer');
const inputB = () => input(B_TOKEN, B_JOB, 'Principal Engineer');

function approve(d: ApplicationDraft): ApprovedDraft<ApplicationDraft> {
  return { reviewItemId: 'r1', draft: d } as unknown as ApprovedDraft<ApplicationDraft>;
}

type Extra = { key: string; label: string; kind: 'text' | 'select' | 'checkbox'; value: string; selector: string };
async function draft(cfg: WorkdayApplyConfig, inp: ApplyInput, extra: Extra[] = [], given: Record<string, string> = {}) {
  const answers: Record<string, string> = { [CONSENT_KEY]: 'Yes', ...given };
  const d = await plugin.prepare(testContext(cfg, http()), inp);
  return applicationDraftSchema.parse({
    ...d,
    fields: [
      ...d.fields.map((f) => (answers[f.key] ? { ...f, value: answers[f.key]!, source: 'human' as const } : f)),
      ...extra.map((e) => ({ key: e.key, label: e.label, kind: e.kind, required: true, selectors: [e.selector], value: e.value, source: 'human' as const })),
    ],
    missingRequired: [],
  });
}

/** Tenant A's answers for the questions it discovers at run time (as the reviewer would approve them). */
const answersA: Extra[] = [
  { key: Q_SOURCE, label: 'How did you hear about us?', kind: 'select', value: 'LinkedIn', selector: 'button[id="source--source"]' },
  { key: Q_YEARS, label: 'How many years of professional software experience do you have?', kind: 'text', value: '2', selector: '#q-years' },
  { key: Q_RELOCATE, label: 'Are you willing to relocate?', kind: 'select', value: 'Yes', selector: 'button[id="q-relocate"]' },
  { key: Q_GENDER, label: 'Gender', kind: 'select', value: 'Male', selector: 'button[id="gender"]' },
  { key: Q_TERMS, label: 'I have read and agree to the terms and conditions (consent — set Yes to agree)', kind: 'checkbox', value: 'Yes', selector: '#terms' },
];

const NEXT_A = 'bottom-navigation-next-button';

/** Tenant A: no account → create → verification email → sign in → autofill → six steps. */
function tenantABrowser(gmail: ReturnType<typeof fakeGmail>, steps = ['my-information', 'my-experience', 'application-questions', 'voluntary-disclosures', 'self-identify', 'review']) {
  let i = -1;
  const browser = fakeBrowser({
    pages: {
      [A_APPLY]: page('sign-in'),
      'https://workday.wd5.myworkdayjobs.com/Workday/activate/*': '<p>Your account has been verified.</p>',
    },
    onClick(sel, cur) {
      if (sel.includes('createAccountLink')) return { html: page('create-account') };
      if (sel.includes('createAccountSubmitButton')) {
        gmail.receive({
          threadId: 't1',
          from: 'Workday <workday@myworkday.com>',
          subject: 'Verify your candidate account',
          html: '<p>Please verify your account.</p><a href="https://workday.wd5.myworkdayjobs.com/Workday/activate/abc123?token=xyz">Verify Account</a>',
          at: new Date(Date.now() + 1000),
        });
        return { html: page('verify-email') };
      }
      if (sel.includes('signInSubmitButton')) return { html: page('autofill') };
      if (sel.includes(NEXT_A) && !cur.html.includes('>Submit<')) return { html: page(steps[++i]!) };
      if (sel.includes(':has-text("Submit")')) return { html: page('submitted') };
      return undefined;
    },
  });
  return browser;
}

describe('actor-apply-workday', () => {
  it('has a valid external manifest with Workday hosts, Gmail read and keychain credentials', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.permissions).toMatchObject({ domains: DOMAINS, browser: true, gmail: ['read'], credentials: true });
    expect(plugin.preview).toBeUndefined();
  });

  it('derives the job path and the apply URL for both host styles', () => {
    expect(externalPath(`${A_JOB}/apply/autofillWithResume`)).toBe('/job/INDPune/DataOps-Engineer_JR-0109475-1');
    expect(externalPath(`https://workday.wd5.myworkdayjobs.com/en-US/Workday/job/INDPune/DataOps-Engineer_JR-0109475-1`)).toBe('/job/INDPune/DataOps-Engineer_JR-0109475-1');
    expect(applyUrlFor(B_JOB, false)).toBe(B_APPLY);
    expect(applyUrlFor(`${A_JOB}/`, true)).toBe(A_APPLY);
  });

  it('reads the active step and the listbox dropdowns', () => {
    expect(activeStep(page('my-information'))).toBe('My Information');
    expect(activeStep(page('review'))).toBe('Review');
    expect(activeStep(page('verify-email'))).toBeNull();
    expect(listboxFields(page('my-information'))).toEqual([{ selector: 'button[id="source--source"]', label: 'How did you hear about us?', kind: 'select', required: true }]);
    expect(listboxFields(page('step-error'))[0]).toMatchObject({ value: expect.stringContaining('LinkedIn') });
  });

  it('prepare (tenant A): one GET of the recorded posting, base questions mapped, autofill apply URL', async () => {
    const h = http();
    const d = await plugin.prepare(testContext(config(), h), inputA());
    expect(h.calls).toEqual([detailApiUrl(parseWorkdayToken(A_TOKEN), externalPath(A_JOB))]);
    // Your consent to the tenant's account terms is the one thing the profile can't answer.
    expect(d).toMatchObject({ ats: 'workday', jobUrl: A_JOB, applyUrl: A_APPLY, missingRequired: [expect.stringMatching(/I accept Acme's Workday candidate account terms/)] });
    expect(Object.fromEntries(d.fields.map((f) => [f.key, f.value]))).toEqual({
      resume: '/tmp/resume.pdf',
      [CONSENT_KEY]: null,
      'my-information:first_name': 'Divyansh',
      'my-information:last_name': 'Parashar',
      'my-information:city': 'Bengaluru',
      'my-information:phone': '7976398973',
      'my-experience:linkedin': 'https://linkedin.com/in/divyansh1212',
    });
  });

  it('prepare (tenant B): shared host, Apply Manually, learned questions added up front', async () => {
    const d = await plugin.prepare(testContext(config(), http()), inputB());
    expect(d.applyUrl).toBe(B_APPLY);
    expect(d.fields.map((f) => f.key)).toEqual(expect.arrayContaining([Q_YEARS, Q_RELOCATE]));
    expect(d.missingRequired).toEqual([expect.stringMatching(/consent/), 'How many years of professional software experience do you have?', 'Are you willing to relocate?']);
  });

  it('prepare refuses a posting that no longer accepts applications', async () => {
    const closed = JSON.parse(readFileSync(fx('workday-detail.json'), 'utf8'));
    closed.jobPostingInfo.canApply = false;
    const h = fixtureHttp({ [detailApiUrl(parseWorkdayToken(A_TOKEN), externalPath(A_JOB))]: { body: closed } }, DOMAINS);
    await expect(plugin.prepare(testContext(config(), h), inputA())).rejects.toThrow(/no longer accepts/);
  });

  it('tenant A dry run: creates the account (keychain), verifies it from the email, autofills, reaches Review, never submits', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const credentials = fakeCredentials();
    const browser = tenantABrowser(gmail);
    const events: Array<[string, Record<string, unknown>]> = [];
    const cfg = config();
    const ctx = testContext(cfg, http(), { browser: browser as BrowserHandle, dryRun: true, gmail, credentials, emit: (k, d) => events.push([k, d]) });
    const r = await plugin.execute(ctx, approve(await draft(cfg, inputA(), answersA)), 'k1');

    expect(r).toMatchObject({ dryRun: true, submitted: false, confirmation: null });
    const password = credentials.saved.get('workday.wd5.myworkdayjobs.com/workday:me@gmail.com');
    expect(password).toBeTruthy();
    expect(events).toEqual([['account_created', { tenant: 'workday', host: 'workday.wd5.myworkdayjobs.com' }]]);
    expect(JSON.stringify(events)).not.toContain(password!);

    const clicks = browser.actions.filter((a) => a.type === 'click').map((a) => a.selector!);
    expect(clicks.some((s) => s.includes(':has-text("Submit")'))).toBe(false);
    expect(clicks.filter((s) => s.includes(NEXT_A))).toHaveLength(6); // autofill + five steps, none on Review
    expect(browser.actions.filter((a) => a.type === 'goto').map((a) => a.url)).toEqual([A_APPLY, 'https://workday.wd5.myworkdayjobs.com/Workday/activate/abc123?token=xyz', A_APPLY]);
    const fills = browser.actions.filter((a) => a.type === 'fill' || a.type === 'type');
    // The same generated password is typed for create, verify and the sign-in after verification.
    expect(fills.filter((a) => a.value === password).map((a) => a.selector)).toEqual(['input[data-automation-id="password"]', 'input[data-automation-id="verifyPassword"]', 'input[data-automation-id="password"]']);
    // Autofill is corrected: "Divyans" on the page is overwritten with the profile's name.
    expect(fills.find((a) => a.selector === 'input[data-automation-id="legalNameSection_firstName"]')!.value).toBe('Divyansh');
    expect(fills.find((a) => a.selector === '#q-years')!.value).toBe('2');
    // Resume uploaded once, on the autofill page.
    expect(browser.actions.filter((a) => a.type === 'upload')).toEqual([expect.objectContaining({ value: '/tmp/resume.pdf' })]);
    expect(clicks).toEqual(expect.arrayContaining(['[role="option"]:has-text("LinkedIn")', '[role="option"]:has-text("Male")', '[role="option"]:has-text("Yes")']));
    expect(browser.actions.find((a) => a.type === 'check' && a.selector === '#terms')).toBeTruthy();
    expect(r.screenshots.map((s) => s.split('/k1-')[1])).toEqual([
      'verify-email.png', 'autofill-with-resume.png', 'my-information.png', 'my-experience.png', 'application-questions.png', 'voluntary-disclosures.png', 'self-identify.png', 'review.png',
    ]);
  });

  it('tenant A live: the same flow presses Submit on Review and reads the confirmation', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const browser = tenantABrowser(gmail);
    const cfg = config();
    const ctx = testContext(cfg, http(), { browser: browser as BrowserHandle, dryRun: false, gmail, credentials: fakeCredentials() });
    const r = await plugin.execute(ctx, approve(await draft(cfg, inputA(), answersA)), 'k2');
    expect(r).toMatchObject({ dryRun: false, submitted: true });
    expect(r.confirmation).toMatch(/Application Submitted/i);
    expect(browser.actions.filter((a) => a.type === 'click').at(-1)!.selector).toBe('button[data-automation-id="bottom-navigation-next-button"]:has-text("Submit")');
  });

  it('tenant B dry run: stored password, tenant Next button, resume on My Experience, no Self Identify, reaches Review', async () => {
    const steps = ['my-information', 'my-experience', 'application-questions', 'voluntary-disclosures', 'review'].map((s) => page(s).replaceAll('bottom-navigation-next-button', 'pageFooterNextButton'));
    let i = -1;
    const browser = fakeBrowser({
      pages: { [B_APPLY]: page('sign-in') },
      onClick(sel, cur) {
        if (sel.includes('signInSubmitButton')) return { html: steps[++i]! };
        if (sel === B_NEXT && !cur.html.includes('>Submit<')) return { html: steps[++i]! };
        return undefined;
      },
    });
    const credentials = fakeCredentials({ 'wd1.myworkdaysite.com/wf:me@gmail.com': 'Stored-Passw0rd!' });
    const cfg = config();
    const d = await draft(cfg, inputB(), answersA.filter((a) => a.key !== Q_YEARS && a.key !== Q_RELOCATE), { [Q_YEARS]: '12', [Q_RELOCATE]: 'No' });
    const ctx = testContext(cfg, http(), { browser: browser as BrowserHandle, dryRun: true, gmail: fakeGmail('me@gmail.com'), credentials });
    const r = await plugin.execute(ctx, approve(d), 'k3');

    expect(r).toMatchObject({ dryRun: true, submitted: false });
    expect(credentials.saved.size).toBe(1); // no new account
    const clicks = browser.actions.filter((a) => a.type === 'click').map((a) => a.selector!);
    expect(clicks.filter((s) => s === B_NEXT)).toHaveLength(4);
    expect(clicks.some((s) => s.includes(':has-text("Submit")') || s.includes('createAccount'))).toBe(false);
    expect(browser.actions.filter((a) => a.type === 'fill').find((a) => a.selector === 'input[data-automation-id="password"]')!.value).toBe('Stored-Passw0rd!');
    expect(browser.actions.filter((a) => a.type === 'upload')).toEqual([expect.objectContaining({ selector: 'input[data-automation-id="file-upload-input-ref"]', url: B_APPLY })]);
    expect(browser.actions.filter((a) => a.type === 'fill' || a.type === 'type').find((a) => a.selector === '#q-years')!.value).toBe('12');
    expect(clicks).toContain('[role="option"]:has-text("No")');
    expect(r.screenshots.some((s) => s.endsWith('self-identify.png'))).toBe(false);
    expect(r.screenshots.at(-1)).toMatch(/review\.png$/);
  });

  it('a required question the draft lacks stops the run (EEO and consent flagged), nothing submitted', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const browser = tenantABrowser(gmail, ['my-information', 'my-experience', 'application-questions', 'voluntary-disclosures']);
    const cfg = config();
    const known = answersA.filter((a) => a.key !== Q_GENDER && a.key !== Q_TERMS);
    const ctx = testContext(cfg, http(), { browser: browser as BrowserHandle, dryRun: false, gmail, credentials: fakeCredentials() });
    const err = await plugin.execute(ctx, approve(await draft(cfg, inputA(), known)), 'k4').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnansweredQuestionsError);
    const qs = (err as UnansweredQuestionsError).questions;
    expect(qs.map((q) => [q.key, q.kind, q.eeo ?? null])).toEqual([
      [Q_TERMS, 'checkbox', null],
      [Q_GENDER, 'select', 'gender'],
    ]);
    expect(qs[0]!.label).toMatch(/consent — set Yes to agree/);
    expect(browser.actions.some((a) => a.type === 'click' && a.selector!.includes(':has-text("Submit")'))).toBe(false);
  });

  it('a step Workday rejects is recorded (HTML + screenshot + step_failed) and fails the run', async () => {
    const credentials = fakeCredentials({ 'workday.wd5.myworkdayjobs.com/workday:me@gmail.com': 'pw-Known1!' });
    const browser = fakeBrowser({
      pages: { [A_APPLY]: page('sign-in') },
      onClick(sel, cur) {
        if (sel.includes('signInSubmitButton')) return { html: page('autofill') };
        if (sel.includes(NEXT_A)) return { html: cur.html.includes('Autofill with Resume') ? page('my-information') : page('step-error') };
        return undefined;
      },
    });
    const events: Array<[string, Record<string, unknown>]> = [];
    const cfg = config();
    const ctx = testContext(cfg, http(), { browser: browser as BrowserHandle, dryRun: true, gmail: fakeGmail('me@gmail.com'), credentials, emit: (k, d) => events.push([k, d]) });
    await expect(plugin.execute(ctx, approve(await draft(cfg, inputA(), answersA)), 'k5')).rejects.toThrow(/did not accept "My Information": Errors Found; Address Line 1 is required/);
    expect(events).toHaveLength(1);
    const [kind, data] = events[0]!;
    expect(kind).toBe('step_failed');
    expect(data).toMatchObject({ tenant: 'workday', step: 'My Information', reason: expect.stringMatching(/Address Line 1 is required/) });
    expect(readFileSync(data.html as string, 'utf8')).toContain('errorBanner');
    expect(existsSync((data.html as string).replace(/\.html$/, '.png'))).toBe(true);
  });

  it('an unrecognised layout is recorded and fails instead of guessing', async () => {
    const browser = fakeBrowser({
      pages: { [A_APPLY]: page('sign-in') },
      onClick: (sel) => (sel.includes('signInSubmitButton') ? { html: '<h2>Something new</h2><input data-automation-id="file-upload-input-ref" type="file"><button data-automation-id="bottom-navigation-next-button">Go</button>' } : sel.includes(NEXT_A) ? { html: '<h1>Totally different page</h1>' } : undefined),
    });
    const events: string[] = [];
    const cfg = config();
    const ctx = testContext(cfg, http(), { browser: browser as BrowserHandle, gmail: fakeGmail('me@gmail.com'), credentials: fakeCredentials({ 'workday.wd5.myworkdayjobs.com/workday:me@gmail.com': 'x' }), emit: (k) => events.push(k) });
    const err = await plugin.execute(ctx, approve(await draft(cfg, inputA(), answersA)), 'k6').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownLayoutError);
    expect((err as UnknownLayoutError).message).toMatch(/layout not recognised/);
    expect((err as UnknownLayoutError).screenshots.at(-1)).toMatch(/unknown\.png$/);
    expect(events).toEqual(['step_failed']);
  });

  it('a stored password Workday rejects is a login block (human), not a retry', async () => {
    const browser = fakeBrowser({ pages: { [A_APPLY]: page('sign-in') }, onClick: (sel, cur) => (sel.includes('signInSubmitButton') ? { html: `${cur.html}<div data-automation-id="errorMessage">Wrong email address or password.</div>` } : undefined) });
    const cfg = config();
    const ctx = testContext(cfg, http(), { browser: browser as BrowserHandle, gmail: fakeGmail('me@gmail.com'), credentials: fakeCredentials({ 'workday.wd5.myworkdayjobs.com/workday:me@gmail.com': 'old' }) });
    const err = await plugin.execute(ctx, approve(await draft(cfg, inputA(), answersA)), 'k7').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionBlockedError);
    expect((err as SessionBlockedError).reason).toBe('login');
  });

  it('an existing account the keychain does not know is a login block with a clear message', async () => {
    const browser = fakeBrowser({
      pages: { [A_APPLY]: page('sign-in') },
      onClick: (sel, cur) =>
        sel.includes('createAccountLink') ? { html: page('create-account') } : sel.includes('createAccountSubmitButton') ? { html: `${cur.html}<div data-automation-id="errorMessage">An account already exists for this email address.</div>` } : undefined,
    });
    const cfg = config();
    const ctx = testContext(cfg, http(), { browser: browser as BrowserHandle, gmail: fakeGmail('me@gmail.com'), credentials: fakeCredentials() });
    await expect(plugin.execute(ctx, approve(await draft(cfg, inputA(), answersA)), 'k8')).rejects.toThrow(/already exists .* sign in \(or reset the password\) by hand/);
  });
});
