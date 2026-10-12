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
  UnknownLayoutError,
  type ApplicationDraft,
  type ApplyInput,
  type ApprovedDraft,
  type BrowserHandle,
} from '@quarry/plugin-sdk';
import { fakeBrowser, fakeCredentials, fakeGmail, fixtureHttp, testContext } from '@quarry/plugin-sdk/testing';
import plugin, { applyUrlFrom, configSchema, sfStep, tenantKey, type SuccessFactorsApplyConfig } from './index.js';

const fx = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const read = (f: string) => readFileSync(fx(f), 'utf8');
const flow = (f: string) => read(`flow/${f}.html`);
const DOMAINS = ['*.successfactors.com', '*.successfactors.eu', '*.sapsf.com', '*.sapsf.eu'];
// The recorded Cargill RMK page, served under an SAP-hosted RMK host the actor can reach.
const HOST = 'jobs.cargill.sapsf.com';
const JOB = `https://${HOST}/job/Bangalore-Sr_-Software-Engineer-Karn-560087/1372916957/`;
const APPLY = `https://${HOST}/talentcommunity/apply/1372916957/?locale=en_US`;
const ACCOUNT = `${HOST}/${HOST}:me@gmail.com`;
const Q_PREV = questionKey('Application', 'Have you previously worked for Cargill?');

const config = (extra: Partial<SuccessFactorsApplyConfig> = {}) => {
  const tmp = mkdtempSync(join(tmpdir(), 'sf-'));
  return configSchema.parse({ screenshotDir: join(tmp, 'shots'), failureDir: join(tmp, 'failures'), typingDelayMs: 0, ...extra });
};
const http = (file = 'cargill-job.html') => fixtureHttp({ [JOB]: { file: fx(file) } }, DOMAINS);

const input = (): ApplyInput => ({
  job: { id: 'j1', companyId: 'c1', company: 'Cargill', title: 'Sr. Software Engineer', normalizedTitle: 'sr software engineer', locations: ['Bangalore'], remotePolicy: null, seniority: null, descriptionMd: 'x', applyUrl: JOB, postedAt: null, embedding: null },
  ats: 'successfactors',
  boardToken: HOST,
  postingId: '1372916957',
  applyUrl: JOB,
  profile: { version: 'v1', preferences: preferencesSchema.parse({}), facts: [], summary: '', embedding: null },
  applicant: preferencesSchema.parse({ application: { first_name: 'Jane', last_name: 'Doe', email: 'me@gmail.com', phone: '5551234567', location: 'Bengaluru' } }).application!,
  resume: { path: '/tmp/resume.pdf', resumeVariantId: null },
});

const approve = (d: ApplicationDraft) => ({ reviewItemId: 'r1', draft: d }) as unknown as ApprovedDraft<ApplicationDraft>;

async function draft(cfg: SuccessFactorsApplyConfig) {
  const d = await plugin.prepare(testContext(cfg, http()), input());
  const fields = [
    ...d.fields.map((f) => (f.key === CONSENT_KEY ? { ...f, value: 'Yes', source: 'human' as const } : f)),
    { key: Q_PREV, label: 'Have you previously worked for Cargill?', kind: 'select' as const, required: true, selectors: ['#q-previous'], options: ['Yes', 'No'], value: 'No', source: 'human' as const },
  ];
  return applicationDraftSchema.parse({ ...d, fields, missingRequired: [] });
}

/** sign in → (create account → emailed link) → data privacy → one-page application. */
function site(gmail: ReturnType<typeof fakeGmail>, application = flow('application')) {
  return fakeBrowser({
    pages: { [APPLY]: flow('sign-in'), [`https://${HOST}/talentcommunity/verify/*`]: '<p>Your account is active.</p>' },
    onClick(sel) {
      if (sel === '#createAccountLink') return { html: flow('create-account') };
      if (sel === '#fbclc_createAccountButton') {
        gmail.receive({ threadId: 't', from: 'Cargill Careers <noreply@successfactors.com>', subject: 'Activate your account', html: `<a href="https://${HOST}/talentcommunity/verify/abc?token=1">Activate account</a>`, at: new Date(Date.now() + 1000) });
        return { html: '<p>Check your email to activate your account.</p>' };
      }
      if (sel === '#signInBtn') return { html: flow('privacy') };
      if (sel === '#dataPrivacyAcceptBtn') return { html: application };
      if (sel === '#fbclc_submit') return { html: flow('submitted') };
      return undefined;
    },
  });
}

describe('actor-apply-successfactors', () => {
  it('has a valid external manifest scoped to SAP hosts, Gmail read and keychain credentials', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.permissions).toMatchObject({ domains: DOMAINS, browser: true, gmail: ['read'], credentials: true });
  });

  it('reads the apply link from the recorded RMK page and refuses the recorded filled posting', () => {
    expect(applyUrlFrom(JOB, read('cargill-job.html'))).toBe(APPLY);
    expect(() => applyUrlFrom('https://jobs.agfa.sapsf.com/job/x/1202266601/', read('agfa-job-filled.html'))).toThrow(/has been filled/);
    const classic = 'https://career4.successfactors.com/career?company=acmeP&career_ns=job_listing&career_job_req_id=12&navBarLevel=JOB_SEARCH';
    expect(applyUrlFrom(classic, '<a id="applyButton">Apply</a>')).toBe(classic);
    expect(tenantKey(classic)).toBe('acmeP');
    expect(tenantKey(JOB)).toBe(HOST);
  });

  it('recognises the one-page application and nothing else', () => {
    expect(sfStep(flow('application'))).toBe('Application');
    expect(sfStep(read('cargill-job.html'))).toBeNull();
    expect(sfStep(flow('unknown'))).toBeNull();
  });

  it('prepare: one GET of the job page, profile answers, consent still to give', async () => {
    const h = http();
    const d = await plugin.prepare(testContext(config(), h), input());
    expect(h.calls).toEqual([JOB]);
    expect(d).toMatchObject({ ats: 'successfactors', jobUrl: JOB, applyUrl: APPLY, missingRequired: [expect.stringMatching(/consent/)] });
    expect(Object.fromEntries(d.fields.map((f) => [f.key, f.value]))).toMatchObject({ resume: '/tmp/resume.pdf', 'application:first_name': 'Jane', 'application:phone': '5551234567' });
    await expect(plugin.prepare(testContext(config(), fixtureHttp({ [JOB]: { file: fx('agfa-job-filled.html') } }, DOMAINS)), input())).rejects.toThrow(/filled/);
  });

  it('dry run, new account: creates it (keychain), activates it from the email link, accepts the privacy statement, fills the application, never submits', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const credentials = fakeCredentials();
    const browser = site(gmail);
    const cfg = config();
    const r = await plugin.execute(testContext(cfg, http(), { browser: browser as BrowserHandle, dryRun: true, gmail, credentials }), approve(await draft(cfg)), 'k1');
    expect(r).toMatchObject({ dryRun: true, submitted: false });
    const pw = credentials.saved.get(ACCOUNT)!;
    const fills = browser.actions.filter((a) => a.type === 'fill' || a.type === 'type');
    const filled = (sel: string) => fills.filter((a) => a.selector === sel).map((a) => a.value);
    expect(filled('#fbclc_userName')).toEqual(['me@gmail.com']);
    expect(filled('#fbclc_emailConf')).toEqual(['me@gmail.com']);
    expect(filled('#fbclc_pwdConf')).toEqual([pw]);
    expect(filled('#fbclc_fName')).toEqual(['Jane']);
    expect(filled('#password')).toEqual([pw]); // the sign-in after activation
    expect(filled('#lastName')).toEqual(['Doe']);
    expect(browser.actions.filter((a) => a.type === 'goto').map((a) => a.url)).toEqual([APPLY, `https://${HOST}/talentcommunity/verify/abc?token=1`, APPLY]);
    expect(browser.actions.filter((a) => a.type === 'check').map((a) => a.selector)).toEqual(['#dataPrivacyId']);
    expect(browser.actions.filter((a) => a.type === 'select')).toEqual([expect.objectContaining({ selector: '#q-previous', value: 'No' })]);
    expect(browser.actions.filter((a) => a.type === 'upload')).toEqual([expect.objectContaining({ value: '/tmp/resume.pdf' })]);
    expect(browser.actions.some((a) => a.type === 'click' && a.selector === '#fbclc_submit')).toBe(false);
    expect(r.screenshots.map((s) => s.split('/k1-')[1])).toEqual(['verify-email.png', 'agreement.png', 'application.png']);
  });

  it('live, existing account: signs in and presses Apply on the filled form', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const browser = site(gmail);
    const cfg = config();
    const ctx = testContext(cfg, http(), { browser: browser as BrowserHandle, dryRun: false, gmail, credentials: fakeCredentials({ [ACCOUNT]: 'Known-1!' }) });
    const r = await plugin.execute(ctx, approve(await draft(cfg)), 'k2');
    expect(r).toMatchObject({ dryRun: false, submitted: true });
    expect(r.confirmation).toMatch(/Thank you for applying/);
    expect(browser.actions.filter((a) => a.type === 'click').map((a) => a.selector)).toEqual(['#signInBtn', '#dataPrivacyAcceptBtn', '#fbclc_submit']);
  });

  it('an unrecognised page after sign-in raises UnknownLayoutError (nothing guessed)', async () => {
    const gmail = fakeGmail('me@gmail.com');
    const browser = site(gmail, flow('unknown'));
    const events: string[] = [];
    const cfg = config();
    const ctx = testContext(cfg, http(), { browser: browser as BrowserHandle, gmail, credentials: fakeCredentials({ [ACCOUNT]: 'Known-1!' }), emit: (k) => events.push(k) });
    const err = await plugin.execute(ctx, approve(await draft(cfg)), 'k3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownLayoutError);
    expect((err as UnknownLayoutError).screenshots.at(-1)).toMatch(/unknown\.png$/);
    expect(events).toEqual(['step_failed']);
    expect(browser.actions.filter((a) => a.type === 'click').map((a) => a.selector)).toEqual(['#signInBtn', '#dataPrivacyAcceptBtn']);
  });
});
