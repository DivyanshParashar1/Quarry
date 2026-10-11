import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { fillForm, submitAndConfirm, UnansweredQuestionsError, type ApplicationDraft, type ApplicationField, type ApplicationResult, type FormQuestion } from './apply.js';
import { SessionBlockedError, type BrowserPage, type DiscoveredField } from './browser.js';
import { waitForOtp } from './otp.js';
import type { PluginContext } from './types.js';

// Phases 20–21: the account-based apply wizard shared by Workday, SuccessFactors
// and Taleo. Each portal is a set of selectors + a step reader (a WizardSpec);
// the engine does the rest:
//   open the apply URL → accept the privacy agreement (only with your consent on
//   the draft) → sign in, or create the tenant account with a keychain password
//   and confirm it (emailed code or link) → walk the steps: upload the resume on
//   its step, fill the draft's answers (overwriting autofill), pick listbox
//   options, stop on required questions the draft lacks, screenshot, Next →
//   at Review: stop (dry run) or Submit and wait for the confirmation.
// A page it can't place is an UnknownLayoutError (the core raises an attention
// item with the screenshots); a step the portal rejects is recorded under
// failureDir with a `step_failed` event — the fixture a tenant override or an
// orchestrator fix starts from.

/** A page the actor doesn't recognise: a human looks at the screenshots instead of the actor guessing. */
export class UnknownLayoutError extends Error {
  constructor(
    message: string,
    readonly screenshots: string[],
    readonly url: string,
    readonly step: string | null,
  ) {
    super(message);
    this.name = 'UnknownLayoutError';
  }
}

export const WIZARD_SELECTOR_KEYS = [
  /** An "Apply" button on the page the apply URL opens (job pages that don't link the form directly). */
  'start',
  'username',
  'password',
  'verifyPassword',
  'createAccountLink',
  'signInLink',
  'createAccountSubmit',
  'signInSubmit',
  'otpInput',
  'otpSubmit',
  /** A privacy/terms checkbox to tick (needs your consent on the draft). */
  'agreementCheckbox',
  /** An "Accept" button on a privacy agreement page (needs your consent). */
  'agreementAccept',
  'next',
  'submit',
  /** An option in an open listbox; %s is the option text. */
  'option',
] as const;
export type WizardSelectorKey = (typeof WIZARD_SELECTOR_KEYS)[number];
export type WizardSelectors = Record<WizardSelectorKey, string[]>;

/** One field of a portal's create-account form. */
export interface CreateAccountField {
  selectors: string[];
  value: 'email' | 'password' | 'first_name' | 'last_name' | 'phone' | { literal: string };
  kind?: 'text' | 'select';
}

export interface WizardSpec {
  /** For messages and file names. */
  name: string;
  /** Sender domains of the portal's verification emails. */
  otpDomains: string[];
  selectors: WizardSelectors;
  /** Filled when creating an account (only the visible ones; email/password always). */
  createAccountForm: CreateAccountField[];
  /** The step the page shows, or null when the layout isn't recognised. */
  stepOf(html: string): string | null;
  isReview(step: string): boolean;
  /** Single-page forms: once this step is filled, it is the review point (no Next). */
  reviewAfterFill?(step: string): boolean;
  /** The step the resume is uploaded on. */
  resumeStep(step: string): boolean;
  confirmation: RegExp;
  /** Global regex; group 1 is a validation message shown after a rejected Next. */
  errorPattern: RegExp;
}

const selectorList = z.array(z.string().min(1)).min(1);

/** Per-tenant overrides (selectors tried first; questions this tenant is known to ask). */
export const wizardTenantSchema = z
  .object({
    selectors: z.object(Object.fromEntries(WIZARD_SELECTOR_KEYS.map((k) => [k, selectorList.optional()])) as Record<WizardSelectorKey, z.ZodOptional<typeof selectorList>>).strict().default({}),
    questions: z
      .array(
        z
          .object({
            step: z.string().min(1),
            label: z.string().min(1),
            kind: z.enum(['text', 'textarea', 'select', 'checkbox', 'radio']),
            selector: z.string().min(1),
            required: z.boolean().default(false),
            options: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type WizardTenant = z.infer<typeof wizardTenantSchema>;

/** Config every wizard actor shares (each adds its own tenant fields). */
export const wizardConfigShape = (failureDir: string) => ({
  screenshotDir: z.string().default('data/screenshots/apply'),
  /** Page HTML + screenshot of every failed step, per tenant. */
  failureDir: z.string().default(failureDir),
  typingDelayMs: z.number().int().min(0).default(35),
  stepWaitMs: z.number().int().min(0).default(2500),
  confirmTimeoutMs: z.number().int().min(0).default(30_000),
  verifyTimeoutMs: z.number().int().min(0).default(5 * 60_000),
  /** Safety stop for unusually long wizards. */
  maxSteps: z.number().int().min(1).max(15).default(10),
});
export interface WizardConfig {
  screenshotDir: string;
  failureDir: string;
  typingDelayMs: number;
  stepWaitMs: number;
  confirmTimeoutMs: number;
  verifyTimeoutMs: number;
  maxSteps: number;
}

export const CONSENT_KEY = 'consent:terms';

/** The draft question that records your consent to the portal's account terms / privacy agreement. */
export function consentQuestion(company: string, portal: string): FormQuestion {
  return {
    key: CONSENT_KEY,
    label: `I accept ${company}'s ${portal} candidate account terms and privacy agreement (consent — set Yes to agree)`,
    kind: 'checkbox',
    required: true,
    selectors: ['(account terms)'],
  };
}

const consented = (draft: ApplicationDraft) => /^(yes|true)$/i.test(draft.fields.find((f) => f.key === CONSENT_KEY)?.value ?? '');

export const stepSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Draft key of a question on a step: "{step}:{label words}". */
export function questionKey(step: string, label: string): string {
  return `${stepSlug(step)}:${label.toLowerCase().replace(/\brequired\b|\bselect one\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

/** The tenant's learned questions, as draft questions. */
export function tenantQuestions(t: WizardTenant | undefined): FormQuestion[] {
  return (t?.questions ?? []).map((x) => ({ key: questionKey(x.step, x.label), label: x.label, kind: x.kind, required: x.required, selectors: [x.selector], ...(x.options ? { options: x.options } : {}) }));
}

/** Dropdowns rendered as <button aria-haspopup="listbox"> (Workday, SAP UI5); describeForm only sees inputs. */
export function listboxFields(html: string): DiscoveredField[] {
  const out: DiscoveredField[] = [];
  for (const m of html.matchAll(/<button\b[^>]*aria-haspopup="listbox"[^>]*>/gi)) {
    const tag = m[0];
    const attr = (n: string) => tag.match(new RegExp(`\\b${n}="([^"]*)"`, 'i'))?.[1];
    const label = attr('aria-label');
    const id = attr('id');
    const auto = attr('data-automation-id');
    if (!label || (!id && !auto)) continue;
    const selected = !/select one/i.test(label);
    out.push({
      selector: id ? `button[id="${id}"]` : `button[data-automation-id="${auto}"]`,
      label: label.replace(/\s*(select one|required)\s*/gi, ' ').trim(),
      kind: 'select',
      required: /\brequired\b/i.test(label) || attr('aria-required') === 'true',
      ...(selected ? { value: label } : {}),
    });
  }
  return out;
}

const EEO: Array<[RegExp, NonNullable<FormQuestion['eeo']>]> = [
  [/gender|\bsex\b/i, 'gender'],
  [/hispanic|latino/i, 'hispanic_latino'],
  [/ethnic|\brace\b/i, 'race'],
  [/veteran/i, 'veteran_status'],
  [/disabilit/i, 'disability_status'],
  [/pronoun/i, 'pronouns'],
];
const CONSENT = /consent|privacy|agree|terms( and conditions)?|acknowledge|data (protection|processing)|gdpr/i;
const EEO_STEP = /voluntary|self.?identif|disclosure|diversity|equal (employment )?opportunit/i;

export function discoveredQuestion(step: string, f: DiscoveredField): FormQuestion {
  const eeo = EEO_STEP.test(step) ? EEO.find(([re]) => re.test(f.label))?.[1] : undefined;
  return {
    key: questionKey(step, f.label),
    // Consent must be given explicitly by you (a required, unanswered checkbox).
    label: f.kind === 'checkbox' && CONSENT.test(f.label) ? `${f.label} (consent — set Yes to agree)` : f.label,
    kind: f.kind,
    required: f.required,
    selectors: [f.selector],
    ...(eeo ? { eeo } : {}),
    ...(f.options?.length ? { options: f.options } : {}),
    ...(f.maxLength ? { maxLength: f.maxLength } : {}),
  };
}

const VERIFY_PROMPT = /verify your (account|email)|verification (email|code)|check your email|activate your account|account (is )?not (yet )?verified|enter the code/i;
const ACCOUNT_EXISTS = /account (already )?exists|already (has|have) an account|(email address|user ?name) is already (in use|taken|registered)/i;
const CAPTCHA = /g-recaptcha|hcaptcha|captcha-container|cf-challenge|verify you are human/i;

export interface WizardRun {
  draft: ApplicationDraft;
  /** Tenant key (overrides, failure folder) and the host, for messages and the keychain account. */
  tenant: string;
  host: string;
  override: WizardTenant | undefined;
  /** false = dry run: stop at Review, never Submit. */
  live: boolean;
  /** Screenshot file-name prefix (the idempotency key). */
  prefix: string;
}

interface State {
  ctx: PluginContext<WizardConfig>;
  spec: WizardSpec;
  run: WizardRun;
  page: BrowserPage;
  screenshots: string[];
  shot: (name: string) => string;
}

/** Walk a portal's account + wizard flow for an approved draft. */
export async function runAccountWizard<C extends WizardConfig>(ctx: PluginContext<C>, spec: WizardSpec, run: WizardRun): Promise<ApplicationResult> {
  const dir = resolve(ctx.config.screenshotDir);
  await mkdir(dir, { recursive: true });
  const s: State = {
    ctx: ctx as unknown as PluginContext<WizardConfig>,
    spec,
    run,
    page: await ctx.browser!.newPage(),
    screenshots: [],
    shot: (name) => `${dir}/${run.prefix.replace(/[^a-z0-9-]+/gi, '_')}-${name}.png`,
  };
  const { page, draft } = { page: s.page, draft: run.draft };
  const wait = () => page.waitForTimeout(ctx.config.stepWaitMs);
  try {
    await page.goto(draft.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await wait();
    const start = await firstVisible(page, sels(s, 'start'));
    if (start) {
      await page.click(start);
      await wait();
    }
    await acceptAgreement(s);
    await signIn(s);

    let previous: string | null = null;
    for (let i = 0; i < ctx.config.maxSteps; i++) {
      if (await acceptAgreement(s)) continue;
      const html = await page.content();
      if (CAPTCHA.test(html)) throw new SessionBlockedError(`${spec.name} asked for a captcha; apply by hand`, 'captcha', page.url());
      const step = spec.stepOf(html);
      if (!step) throw await unknownLayout(s, null, `could not tell which ${spec.name} step is showing`);
      if (spec.isReview(step)) return await review(s, step);
      if (step === previous) {
        const errors = [...html.matchAll(spec.errorPattern)].map((m) => m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
        await recordFailure(s, step, `${spec.name} did not accept the step: ${errors.join('; ') || 'no error shown'}`);
        throw new Error(`${spec.name} did not accept "${step}": ${errors.join('; ') || 'it stayed on the same step'}; see the failure capture`);
      }
      previous = step;
      await fillStep(s, step);
      await snap(s, stepSlug(step));
      if (spec.reviewAfterFill?.(step)) return await review(s, step);
      const next = await firstVisible(page, sels(s, 'next'));
      if (!next) throw await unknownLayout(s, step, `no Next / Save and Continue button on "${step}"`);
      await page.click(next);
      await wait();
    }
    throw new Error(`no review step after ${ctx.config.maxSteps} steps`);
  } finally {
    await page.close();
  }
}

async function review(s: State, step: string): Promise<ApplicationResult> {
  if (!s.run.live) {
    if (!s.spec.reviewAfterFill?.(step)) await snap(s, 'review');
    return { dryRun: true, submitted: false, confirmation: null, screenshots: s.screenshots, at: new Date().toISOString() };
  }
  if (!(await firstVisible(s.page, sels(s, 'submit')))) throw await unknownLayout(s, step, `no Submit button on "${step}"`);
  const gmail = s.ctx.gmail;
  return submitAndConfirm(
    s.page,
    {
      submit: sels(s, 'submit'),
      confirmation: s.spec.confirmation,
      confirmTimeoutMs: s.ctx.config.confirmTimeoutMs,
      ...(gmail?.search
        ? { otp: { prompt: VERIFY_PROMPT, input: sels(s, 'otpInput'), submit: sels(s, 'otpSubmit'), wait: (since: Date) => waitForOtp(gmail, { fromDomains: s.spec.otpDomains, since, timeoutMs: s.ctx.config.verifyTimeoutMs }) } }
        : {}),
    },
    s.screenshots,
    s.shot,
  );
}

const sels = (s: State, k: WizardSelectorKey) => [...(s.run.override?.selectors[k] ?? []), ...s.spec.selectors[k]];

async function firstVisible(page: BrowserPage, selectors: readonly string[]): Promise<string | null> {
  for (const x of selectors) if (await page.isVisible(x)) return x;
  return null;
}

async function snap(s: State, name: string): Promise<void> {
  s.screenshots.push(s.shot(name));
  await s.page.screenshot({ path: s.screenshots.at(-1)!, fullPage: true });
}

/** A privacy agreement page / terms checkbox: accepted only when you said Yes on the draft. */
async function acceptAgreement(s: State): Promise<boolean> {
  const accept = await firstVisible(s.page, sels(s, 'agreementAccept'));
  if (!accept) return false;
  if (!consented(s.run.draft)) throw new UnansweredQuestionsError([consentQuestion(s.run.draft.company, s.spec.name)]);
  await snap(s, 'agreement');
  await s.page.click(accept);
  await s.page.waitForTimeout(s.ctx.config.stepWaitMs);
  return true;
}

/**
 * Sign in to the tenant, or create its account. The password is generated and
 * stored in the keychain before the account is created, so a crash in between
 * never loses it. Verification by emailed code or link.
 */
async function signIn(s: State): Promise<void> {
  const { page, ctx, run, spec } = s;
  if (!(await firstVisible(page, sels(s, 'password')))) return; // no login wall
  if (!ctx.credentials) throw new Error(`signing in to ${spec.name} needs the credentials permission`);
  const email = ctx.gmail?.address;
  if (!email) throw new Error(`${spec.name} accounts use your Gmail address; connect Gmail (\`quarry gmail auth\`)`);
  const account = `${run.host}/${run.tenant}:${email}`;
  let password = await ctx.credentials.get(account);
  const where = `${run.host}/${run.tenant}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (password) {
      if (await firstVisible(page, sels(s, 'verifyPassword'))) await clickFirst(s, 'signInLink', 'the Sign In link');
      await fillFirst(s, 'username', email);
      await fillFirst(s, 'password', password);
      await clickFirst(s, 'signInSubmit', 'the Sign In button');
    } else {
      if (!(await firstVisible(page, sels(s, 'verifyPassword')))) await clickFirst(s, 'createAccountLink', 'the Create Account link');
      const box = await firstVisible(page, sels(s, 'agreementCheckbox'));
      if (box && !consented(run.draft)) throw new UnansweredQuestionsError([consentQuestion(run.draft.company, spec.name)]);
      password = await ctx.credentials.create(account);
      ctx.emit?.('account_created', { tenant: run.tenant, host: run.host });
      await fillCreateForm(s, email, password);
      if (box) await page.check(box);
      await clickFirst(s, 'createAccountSubmit', 'the Create Account button');
    }
    const since = new Date();
    await page.waitForTimeout(ctx.config.stepWaitMs);
    const html = await page.content();
    if (CAPTCHA.test(html)) throw new SessionBlockedError(`${spec.name} (${run.tenant}) asked for a captcha at sign-in; apply by hand`, 'captcha', page.url());
    if (VERIFY_PROMPT.test(html)) {
      await snap(s, 'verify-email');
      if (!ctx.gmail?.search) throw new Error(`${spec.name} sent a verification email, and reading it needs the gmail read permission`);
      const codeField = await firstVisible(page, sels(s, 'otpInput'));
      const got = await waitForOtp(ctx.gmail, { fromDomains: spec.otpDomains, since, want: codeField ? 'code' : 'link', timeoutMs: ctx.config.verifyTimeoutMs });
      if (codeField && got.code) {
        await page.fill(codeField, got.code);
        await clickFirst(s, 'otpSubmit', 'the button to submit the verification code');
        await page.waitForTimeout(ctx.config.stepWaitMs);
      } else {
        await page.goto(got.link!, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(ctx.config.stepWaitMs);
        await page.goto(run.draft.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(ctx.config.stepWaitMs);
        await acceptAgreement(s);
      }
      if (!(await firstVisible(page, sels(s, 'password')))) return;
      continue; // verified: sign in with the stored password
    }
    if (!(await firstVisible(page, sels(s, 'password')))) return; // signed in
    await snap(s, 'sign-in-failed');
    const reason = ACCOUNT_EXISTS.test(html)
      ? `an account for ${email} already exists on ${where} with a password Quarry doesn't have; sign in (or reset the password) by hand`
      : `could not sign in to ${spec.name} at ${where}; check the sign-in screenshot`;
    throw new SessionBlockedError(reason, 'login', page.url());
  }
  throw new SessionBlockedError(`still not signed in to ${spec.name} at ${where} after verifying the account`, 'login', page.url());
}

async function fillCreateForm(s: State, email: string, password: string): Promise<void> {
  const a = s.run.draft.fields;
  const answer = (key: string) => a.find((f) => f.key.endsWith(`:${key}`))?.value ?? null;
  // Email and password always; the rest only where the form shows them.
  await fillFirst(s, 'username', email);
  await fillFirst(s, 'password', password);
  const verify = await firstVisible(s.page, sels(s, 'verifyPassword'));
  if (verify) await s.page.fill(verify, password);
  for (const f of s.spec.createAccountForm) {
    const sel = await firstVisible(s.page, f.selectors);
    if (!sel) continue;
    const v = typeof f.value === 'object' ? f.value.literal : f.value === 'email' ? email : f.value === 'password' ? password : answer(f.value);
    if (!v) continue;
    if (f.kind === 'select') await s.page.selectOption(sel, v);
    else await s.page.fill(sel, v);
  }
}

async function fillFirst(s: State, key: WizardSelectorKey, value: string): Promise<void> {
  const sel = await firstVisible(s.page, sels(s, key));
  if (!sel) throw await unknownLayout(s, 'sign-in', `no ${key} field on the ${s.spec.name} sign-in page`);
  await s.page.fill(sel, value);
}

async function clickFirst(s: State, key: WizardSelectorKey, what: string): Promise<void> {
  const sel = await firstVisible(s.page, sels(s, key));
  if (!sel) throw await unknownLayout(s, 'sign-in', `no ${what} on the ${s.spec.name} page`);
  await s.page.click(sel);
}

/** Fill the draft's answers for this step, then stop on any required question it doesn't answer. */
async function fillStep(s: State, step: string): Promise<void> {
  const { page, run } = s;
  const draft = run.draft;
  const slug = stepSlug(step);
  const here = draft.fields.filter((f) => f.value && (f.key.startsWith(`${slug}:`) || (f.key === 'resume' && s.spec.resumeStep(step))));
  const missing: string[] = [];
  const plain: ApplicationField[] = [];
  for (const f of here) {
    if (f.selectors[0]!.startsWith('button') && (f.kind === 'select' || f.kind === 'radio')) {
      if (!(await chooseListbox(s, f))) missing.push(f.label);
    } else plain.push(f);
  }
  missing.push(...(await fillForm(page, { ...draft, fields: plain }, { typingDelayMs: s.ctx.config.typingDelayMs })));
  if (missing.length) {
    await recordFailure(s, step, `fields not found: ${missing.join(', ')}`);
    throw new Error(`could not find these fields on "${step}": ${missing.join(', ')}; see the failure capture`);
  }
  const box = await firstVisible(page, sels(s, 'agreementCheckbox'));
  if (box) {
    if (!consented(draft)) throw new UnansweredQuestionsError([consentQuestion(draft.company, s.spec.name)]);
    await page.check(box);
  }
  const known = new Set(draft.fields.map((f) => f.key));
  const discovered = [...((await page.describeForm?.()) ?? []), ...listboxFields(await page.content())];
  const unknown = discovered.filter((f) => f.required && !f.value && f.label.trim() && !known.has(questionKey(step, f.label)));
  if (unknown.length) {
    await snap(s, `${slug}-questions`);
    throw new UnansweredQuestionsError(unknown.map((f) => discoveredQuestion(step, f)));
  }
}

/** A listbox dropdown: open it, pick the option. */
async function chooseListbox(s: State, f: ApplicationField): Promise<boolean> {
  const btn = await firstVisible(s.page, f.selectors);
  if (!btn) return false;
  await s.page.click(btn);
  await s.page.waitForTimeout(500);
  const opt = await firstVisible(s.page, sels(s, 'option').map((x) => x.replace('%s', f.value!.replace(/"/g, '\\"'))));
  if (!opt) return false;
  await s.page.click(opt);
  return true;
}

async function unknownLayout(s: State, step: string | null, message: string): Promise<UnknownLayoutError> {
  await recordFailure(s, step ?? 'unknown', message);
  return new UnknownLayoutError(`${message} (layout not recognised); see the screenshots`, [...s.screenshots], s.page.url(), step);
}

/** Keep the page as it was when a step failed: the reproducing fixture for a tenant override or fix. */
async function recordFailure(s: State, step: string, reason: string): Promise<void> {
  try {
    const dir = resolve(s.ctx.config.failureDir, s.run.tenant.replace(/[^a-z0-9_-]+/gi, '_'));
    await mkdir(dir, { recursive: true });
    const base = `${dir}/${new Date().toISOString().replace(/[:.]/g, '-')}-${stepSlug(step) || 'step'}`;
    await writeFile(`${base}.html`, await s.page.content());
    await s.page.screenshot({ path: `${base}.png`, fullPage: true });
    s.screenshots.push(`${base}.png`);
    s.ctx.emit?.('step_failed', { tenant: s.run.tenant, host: s.run.host, step, reason, html: `${base}.html`, url: s.page.url() });
  } catch (err) {
    s.ctx.log.warn({ err: (err as Error).message }, `could not record the ${s.spec.name} failure`);
  }
}
