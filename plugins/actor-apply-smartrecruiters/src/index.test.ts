import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applicationDraftSchema,
  pluginManifestSchema,
  preferencesSchema,
  UnansweredQuestionsError,
  type ApplicationDraft,
  type ApplyInput,
  type ApprovedDraft,
  type BrowserHandle,
} from '@quarry/plugin-sdk';
import { fakeBrowser, fakeGmail, fixtureHttp, testContext } from '@quarry/plugin-sdk/testing';
import plugin, { configSchema, configUrl, formUrl, laterKey, parseCompanyId, postingUrl, questionsFromConfig } from './index.js';

const fx = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const UUID = 'eac269c5-ee2f-4588-8217-5af3d422b472';
const CID = '58652035e4b04016904de9fe';
const FORM = formUrl('BoschGroup', UUID);
const DOMAINS = ['api.smartrecruiters.com', 'jobs.smartrecruiters.com'];

const http = () =>
  fixtureHttp(
    {
      [postingUrl('BoschGroup', '744000154820678')]: { file: fx('bosch-posting.json') },
      [FORM]: { file: fx('bosch-form-head.html') },
      [configUrl(CID, UUID)]: { file: fx('bosch-config.json') },
    },
    DOMAINS,
  );

const input = (): ApplyInput => ({
  job: { id: 'j1', companyId: 'c1', company: 'Bosch Group', title: 'Sr. Embedded SW developer', normalizedTitle: 'sr embedded sw developer', locations: ['Bangalore'], remotePolicy: null, seniority: null, descriptionMd: 'Embedded C', applyUrl: null, postedAt: null, embedding: null },
  ats: 'smartrecruiters',
  boardToken: 'BoschGroup',
  postingId: '744000154820678',
  applyUrl: 'https://jobs.smartrecruiters.com/BoschGroup/744000154820678-sr-embedded-sw-developer-orc2-edc3',
  profile: { version: 'v1', preferences: preferencesSchema.parse({}), facts: [], summary: '', embedding: null },
  applicant: preferencesSchema.parse({
    application: { first_name: 'Divyansh', last_name: 'Parashar', email: 'me@example.com', phone: '7976398973', linkedin_url: 'https://linkedin.com/in/divyansh1212', location: 'Bengaluru' },
  }).application!,
  resume: { path: '/tmp/resume.pdf', resumeVariantId: null },
});

const STEP1 = `<div data-test="personal-information"><input id="first-name-input"><input id="last-name-input"><input id="email-input"><input id="confirm-email-input">
<spl-autocomplete data-test="location-autocomplete"><input></spl-autocomplete><oc-phone-number><input type="tel"></oc-phone-number>
<input id="linkedin-input"><input id="website-input"><spl-dropzone data-test="resume-upload"><input type="file"></spl-dropzone>
<textarea id="hiring-manager-message-input"></textarea></div><oc-button data-test="footer-next"><button>Next</button></oc-button>`;
const STEP2 = `<h2>Screening questions</h2>
<input id="q-years" data-label="How many years of embedded C experience do you have?" type="text" required>
<input id="q-consent" data-label="I agree to the privacy policy" type="checkbox" required>
<oc-button data-test="footer-submit"><button>Submit</button></oc-button>`;
const OTP_PAGE = `<p>Enter the verification code we sent to your email</p><input autocomplete="one-time-code" id="otp"><button>Verify</button>`;
const DONE = '<h1>Thank you for your application!</h1>';

function approve(d: ApplicationDraft): ApprovedDraft<ApplicationDraft> {
  return { reviewItemId: 'r1', draft: d } as unknown as ApprovedDraft<ApplicationDraft>;
}

describe('actor-apply-smartrecruiters', () => {
  it('has a valid external manifest scoped to SmartRecruiters (+ Gmail read for codes)', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.permissions).toMatchObject({ domains: DOMAINS, browser: true, gmail: ['read'] });
  });

  it('reads the internal company id from the recorded form page', () => {
    expect(parseCompanyId(readFileSync(fx('bosch-form-head.html'), 'utf8'))).toBe(CID);
  });

  it('builds step-1 questions from the recorded config', () => {
    const q = questionsFromConfig(JSON.parse(readFileSync(fx('bosch-config.json'), 'utf8')));
    expect(q.map((x) => [x.key, x.required])).toEqual([
      ['s1:first_name', true],
      ['s1:last_name', true],
      ['s1:email', true],
      ['s1:email_confirm', true],
      ['s1:city', false],
      ['s1:phone', true],
      ['s1:linkedin', false],
      ['s1:website', false],
      ['s1:resume', false],
      ['s1:message', false],
    ]);
    expect(() => questionsFromConfig({ fieldSets: { experience: { required: true, visible: true } } })).toThrow(/experience\/education/);
  });

  it('prepare: three GETs, deterministic answers, the confirm-email copy', async () => {
    const h = http();
    const d = await plugin.prepare(testContext(configSchema.parse({}), h), input());
    expect(h.calls).toEqual([postingUrl('BoschGroup', '744000154820678'), FORM, configUrl(CID, UUID)]);
    const v = Object.fromEntries(d.fields.map((f) => [f.key, f.value]));
    expect(v).toMatchObject({
      's1:first_name': 'Divyansh',
      's1:last_name': 'Parashar',
      's1:email': 'me@example.com',
      's1:email_confirm': 'me@example.com',
      's1:phone': '7976398973',
      's1:city': 'Bengaluru',
      's1:resume': '/tmp/resume.pdf',
      's1:message': null,
    });
    expect(d).toMatchObject({ ats: 'smartrecruiters', applyUrl: FORM, missingRequired: [] });
  });

  async function draftFor(extra: Array<{ key: string; label: string; kind: 'text' | 'checkbox'; value: string; selector: string }> = []) {
    const d = await plugin.prepare(testContext(configSchema.parse({}), http()), input());
    return applicationDraftSchema.parse({
      ...d,
      fields: [...d.fields, ...extra.map((e) => ({ key: e.key, label: e.label, kind: e.kind, required: true, selectors: [e.selector], value: e.value, source: 'human' as const }))],
    });
  }

  it('a dry run fills step 1 and never presses Next', async () => {
    const browser = fakeBrowser({ pages: { [FORM]: STEP1 } });
    const r = await plugin.execute(testContext(configSchema.parse({ screenshotDir: mkdtempSync(join(tmpdir(), 'sr-')) }), http(), { browser: browser as BrowserHandle, dryRun: true }), approve(await draftFor()), 'k1');
    expect(r).toMatchObject({ dryRun: true, submitted: false });
    expect(browser.actions.filter((a) => a.type === 'click')).toEqual([]);
    expect(browser.actions.filter((a) => a.type === 'fill' || a.type === 'type').map((a) => a.value)).toEqual(
      expect.arrayContaining(['Divyansh', 'Parashar', 'me@example.com', '7976398973']),
    );
  });

  it('live: step 2 answered, submit → emailed code typed → confirmation', async () => {
    const gmail = fakeGmail('me@gmail.com');
    let page = 'step1';
    const browser = fakeBrowser({
      pages: { [FORM]: STEP1 },
      onClick(sel) {
        if (page === 'step1' && sel.includes('footer-next')) return ((page = 'step2'), { html: STEP2 });
        if (page === 'step2' && sel.includes('footer-submit')) {
          page = 'otp';
          gmail.receive({ threadId: 't', from: 'SmartRecruiters <noreply@smartrecruiters.com>', subject: 'Verify your email', body: 'Your verification code is 482913. It expires in 15 minutes.', at: new Date(Date.now() + 1000) });
          return { html: OTP_PAGE };
        }
        if (page === 'otp' && sel.includes('Verify')) return ((page = 'done'), { html: DONE });
        return undefined;
      },
    });
    const draft = await draftFor([
      { key: laterKey('How many years of embedded C experience do you have?'), label: 'How many years of embedded C experience do you have?', kind: 'text', value: '2', selector: '#q-years' },
      { key: laterKey('I agree to the privacy policy'), label: 'I agree to the privacy policy (consent — set Yes to agree)', kind: 'checkbox', value: 'Yes', selector: '#q-consent' },
    ]);
    const ctx = testContext(configSchema.parse({ screenshotDir: mkdtempSync(join(tmpdir(), 'sr-')) }), http(), { browser: browser as BrowserHandle, dryRun: false, gmail });
    const r = await plugin.execute(ctx, approve(draft), 'k2');
    expect(r).toMatchObject({ dryRun: false, submitted: true });
    expect(r.confirmation).toMatch(/Thank you for your application/);
    const fills = browser.actions.filter((a) => a.type === 'fill' || a.type === 'type');
    expect(fills.find((a) => a.selector === '#q-years')!.value).toBe('2');
    expect(fills.find((a) => a.selector === 'input[autocomplete="one-time-code"]')!.value).toBe('482913');
    expect(browser.actions.find((a) => a.type === 'check')!.selector).toBe('#q-consent');
    expect(browser.actions.filter((a) => a.type === 'click').map((a) => a.selector)).toEqual([
      'oc-button[data-test="footer-next"] button',
      'oc-button[data-test="footer-submit"] button',
      'button:has-text("Verify")',
    ]);
  });

  it('live: a required question the draft lacks stops before submitting', async () => {
    const browser = fakeBrowser({ pages: { [FORM]: STEP1 }, onClick: (sel) => (sel.includes('footer-next') ? { html: STEP2 } : undefined) });
    const ctx = testContext(configSchema.parse({ screenshotDir: mkdtempSync(join(tmpdir(), 'sr-')) }), http(), { browser: browser as BrowserHandle, dryRun: false });
    const err = await plugin.execute(ctx, approve(await draftFor()), 'k3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnansweredQuestionsError);
    expect((err as UnansweredQuestionsError).questions.map((q) => [q.key, q.kind, q.required])).toEqual([
      [laterKey('How many years of embedded C experience do you have?'), 'text', true],
      [laterKey('I agree to the privacy policy'), 'checkbox', true],
    ]);
    expect((err as UnansweredQuestionsError).questions[1]!.label).toMatch(/consent — set Yes to agree/);
    expect(browser.actions.filter((a) => a.type === 'click').map((a) => a.selector)).toEqual(['oc-button[data-test="footer-next"] button']);
  });
});
