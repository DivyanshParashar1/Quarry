import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  applicationDraftSchema,
  defineActorPlugin,
  detailApiUrl,
  draftConfidence,
  fillForm,
  mapAnswers,
  parseWorkdayToken,
  parseWorkdayUrl,
  SessionBlockedError,
  submitAndConfirm,
  UnansweredQuestionsError,
  waitForOtp,
  type ApplicationDraft,
  type ApplicationField,
  type ApplicationResult,
  type ApplyInput,
  type BrowserPage,
  type DiscoveredField,
  type FieldKind,
  type FormQuestion,
  type PluginContext,
  type WorkdayBoard,
} from '@jobforge/plugin-sdk';

// Phase 20: Workday apply. Every tenant is its own site with its own candidate
// account, so the flow is:
//   prepare: GET the posting from the public CXS API (no side effects), then the
//   fields every Workday wizard has (My Information basics, the resume) plus the
//   tenant's known extra questions from config → deterministic mapping.
//   execute (approved draft only): open {job}/apply/autofillWithResume, sign in —
//   or create the tenant account with a generated password kept in the OS keychain
//   and confirm it from the verification email — upload the resume (Workday
//   autofills), then walk the wizard step by step: fill (overwriting autofill),
//   discover required questions the draft doesn't answer (→ UnansweredQuestionsError,
//   nothing submitted), screenshot, "Save and Continue". Stops at Review on a dry
//   run; a live run presses Submit and waits for the confirmation.
// A step Workday rejects or whose fields can't be found is recorded (HTML +
// screenshot under failureDir, a `step_failed` event) so a tenant override can
// be learned from it (Phase 22).

export const PLUGIN_ID = 'actor-apply-workday';
export const OTP_DOMAINS = ['myworkday.com', 'myworkdayjobs.com', 'myworkdaysite.com'];

/** Selector lists a tenant may override (its own entries are tried first). */
export const SEL = {
  email: ['input[data-automation-id="email"]'],
  password: ['input[data-automation-id="password"]'],
  verifyPassword: ['input[data-automation-id="verifyPassword"]'],
  createAccountCheckbox: ['input[data-automation-id="createAccountCheckbox"]'],
  createAccountLink: ['button[data-automation-id="createAccountLink"]'],
  signInLink: ['button[data-automation-id="signInLink"]'],
  createAccountSubmit: ['button[data-automation-id="createAccountSubmitButton"]', 'div[data-automation-id="click_filter"][aria-label="Create Account"]'],
  signInSubmit: ['button[data-automation-id="signInSubmitButton"]', 'div[data-automation-id="click_filter"][aria-label="Sign In"]'],
  resumeUpload: ['input[data-automation-id="file-upload-input-ref"]'],
  next: ['button[data-automation-id="bottom-navigation-next-button"]'],
  submit: ['button[data-automation-id="bottom-navigation-next-button"]:has-text("Submit")', 'button:has-text("Submit")'],
  option: ['[role="option"]:has-text("%s")', 'div[data-automation-id="promptOption"]:has-text("%s")'],
};
export type SelectorKey = keyof typeof SEL;

const selectorList = z.array(z.string().min(1)).min(1);
const tenantSchema = z
  .object({
    /** Selectors tried before the defaults, per key of SEL. */
    selectors: z.object(Object.fromEntries(Object.keys(SEL).map((k) => [k, selectorList.optional()])) as Record<SelectorKey, z.ZodOptional<typeof selectorList>>).strict().default({}),
    /** false = "Apply Manually" (no resume autofill); the resume is uploaded on My Experience instead. */
    autofill: z.boolean().default(true),
    /** Questions this tenant is known to ask (learned from failures), added to the draft up front. */
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
export type TenantOverride = z.infer<typeof tenantSchema>;

export const configSchema = z
  .object({
    screenshotDir: z.string().default('data/screenshots/apply'),
    /** Page HTML + screenshot of every failed step, per tenant (the fixture a fix starts from). */
    failureDir: z.string().default('data/apply-failures/workday'),
    typingDelayMs: z.number().int().min(0).default(35),
    stepWaitMs: z.number().int().min(0).default(2500),
    confirmTimeoutMs: z.number().int().min(0).default(30_000),
    verifyTimeoutMs: z.number().int().min(0).default(5 * 60_000),
    /** Safety stop for unusually long wizards. */
    maxSteps: z.number().int().min(1).max(15).default(10),
    /** Per-tenant overrides, keyed by the Workday tenant (e.g. "wf", "workday"). */
    tenants: z.record(z.string(), tenantSchema).default({}),
  })
  .strict();
export type WorkdayApplyConfig = z.infer<typeof configSchema>;

const detailSchema = z
  .object({
    jobPostingInfo: z.object({ title: z.string(), externalUrl: z.string().nullable().optional(), canApply: z.boolean().nullable().optional() }).passthrough(),
  })
  .passthrough();

export const CONFIRMATION = /application (has been |was )?(successfully )?submitted|thank you for (your application|applying)|you have (successfully )?applied|\/(confirmation|thank-?you)\b/i;
export const VERIFY_PROMPT = /verify your (account|email)|verification email|check your email|activate your account|account (is )?not (yet )?verified/i;
const ACCOUNT_EXISTS = /account (already )?exists|already (has|have) an account|email address is already in use/i;
const CAPTCHA = /g-recaptcha|hcaptcha|captcha-container|cf-challenge|verify you are human/i;

export const STEPS = ['My Information', 'My Experience', 'Application Questions', 'Voluntary Disclosures', 'Self Identify', 'Review'] as const;

export const stepSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Draft key of a question discovered on a step: "{step}:{label words}". */
export function questionKey(step: string, label: string): string {
  return `${stepSlug(step)}:${label.toLowerCase().replace(/\brequired\b|\bselect one\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

/** The public job path (/job/…) of a Workday job URL, for the CXS detail call. */
export function externalPath(jobUrl: string): string {
  const p = new URL(jobUrl).pathname;
  const i = p.indexOf('/job/');
  if (i < 0) throw new Error(`not a Workday job URL: ${jobUrl}`);
  return p.slice(i).replace(/\/apply(\/.*)?$/, '').replace(/\/$/, '');
}

export function applyUrlFor(jobUrl: string, autofill: boolean): string {
  const u = new URL(jobUrl);
  u.pathname = `${u.pathname.replace(/\/apply(\/.*)?$/, '').replace(/\/$/, '')}/apply/${autofill ? 'autofillWithResume' : 'applyManually'}`;
  u.search = '';
  return u.href;
}

/** The step the wizard shows: the progress bar's active step, else the first known step name in a heading. */
export function activeStep(html: string): string | null {
  const at = html.search(/data-automation-id="progressBarActiveStep"/i);
  // The active step is an <li> holding "current step N of M" and the step's label.
  const bar = at < 0 ? '' : (html.slice(at).match(/^[^>]*>([\s\S]*?)<\/li>/i)?.[1] ?? html.slice(at, at + 400).replace(/^[^>]*>/, ''));
  const text = bar.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text) return STEPS.find((s) => text.toLowerCase().includes(s.toLowerCase())) ?? (text.replace(/^current step \d+ of \d+\s*/i, '') || null);
  for (const m of html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    const h = m[1]!.replace(/<[^>]+>/g, ' ').trim();
    const s = STEPS.find((x) => h.toLowerCase() === x.toLowerCase());
    if (s) return s;
  }
  return null;
}

/** Workday renders dropdowns as <button aria-haspopup="listbox">; describeForm only sees inputs. */
export function listboxFields(html: string): DiscoveredField[] {
  const out: DiscoveredField[] = [];
  for (const m of html.matchAll(/<button\b[^>]*aria-haspopup="listbox"[^>]*>/gi)) {
    const tag = m[0];
    const attr = (n: string) => tag.match(new RegExp(`\\b${n}="([^"]*)"`, 'i'))?.[1];
    const label = attr('aria-label');
    const id = attr('id');
    const auto = attr('data-automation-id');
    if (!label || (!id && !auto)) continue;
    const selected = !/select one/i.test(label) && !/>\s*select one\s*</i.test(tag);
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

export function discoveredQuestion(step: string, f: DiscoveredField): FormQuestion {
  const eeo = /voluntary|self identify|disclosure/i.test(step) ? EEO.find(([re]) => re.test(f.label))?.[1] : undefined;
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

const MY_INFO = stepSlug('My Information');
const MY_EXP = stepSlug('My Experience');

/** Fields every Workday wizard has, plus the tenant's learned questions. */
export function baseQuestions(tenant: TenantOverride | undefined): FormQuestion[] {
  const q: FormQuestion[] = [
    { key: 'resume', label: 'Resume/CV', kind: 'file', required: true, selectors: [...(tenant?.selectors.resumeUpload ?? []), ...SEL.resumeUpload] },
    { key: `${MY_INFO}:first_name`, label: 'First Name', kind: 'text', required: true, selectors: ['input[data-automation-id="legalNameSection_firstName"]'] },
    { key: `${MY_INFO}:last_name`, label: 'Last Name', kind: 'text', required: true, selectors: ['input[data-automation-id="legalNameSection_lastName"]'] },
    { key: `${MY_INFO}:city`, label: 'City', kind: 'text', required: false, selectors: ['input[data-automation-id="addressSection_city"]'] },
    { key: `${MY_INFO}:phone`, label: 'Phone Number', kind: 'text', required: true, selectors: ['input[data-automation-id="phone-number"]'] },
    { key: `${MY_EXP}:linkedin`, label: 'LinkedIn', kind: 'text', required: false, selectors: ['input[data-automation-id="linkedinQuestion"]'] },
  ];
  for (const x of tenant?.questions ?? []) {
    q.push({ key: questionKey(x.step, x.label), label: x.label, kind: x.kind as FieldKind, required: x.required, selectors: [x.selector], ...(x.options ? { options: x.options } : {}) });
  }
  return q;
}

const sels = (tenant: TenantOverride | undefined, k: SelectorKey) => [...(tenant?.selectors[k] ?? []), ...SEL[k]];

async function firstVisible(page: BrowserPage, selectors: readonly string[]): Promise<string | null> {
  for (const s of selectors) if (await page.isVisible(s)) return s;
  return null;
}

export default defineActorPlugin<WorkdayApplyConfig, ApplyInput, ApplicationDraft, ApplicationResult>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.1.0',
    stage: 'actor',
    description: 'Fills a Workday application (tenant account, resume autofill, multi-step wizard) from your profile; submits only after approval.',
    configSchema,
    permissions: { domains: ['*.myworkdayjobs.com', '*.myworkdaysite.com', '*.myworkday.com'], browser: true, gmail: ['read'], credentials: true },
    rateLimit: { perDomain: { tokens: 1, intervalMs: 2000 } },
    sideEffects: 'external',
  },

  // No side effects: one GET of the public posting, then deterministic mapping.
  async prepare(ctx, input) {
    const board = parseWorkdayToken(input.boardToken);
    const tenant = ctx.config.tenants[board.tenant];
    const detail = detailSchema.parse(await ctx.http.getJson(detailApiUrl(board, externalPath(input.applyUrl))));
    if (detail.jobPostingInfo.canApply === false) throw new Error('this Workday posting no longer accepts applications');
    const jobUrl = detail.jobPostingInfo.externalUrl || input.applyUrl;
    const { fields } = mapAnswers(baseQuestions(tenant), input);
    return applicationDraftSchema.parse({
      channel: 'apply',
      ats: 'workday',
      title: input.job.title,
      company: input.job.company,
      jobUrl,
      applyUrl: applyUrlFor(jobUrl, tenant?.autofill ?? true),
      resumePath: input.resume.path,
      resumeVariantId: input.resume.resumeVariantId,
      fields,
      missingRequired: fields.filter((f) => f.required && !f.value).map((f) => f.label),
      confidence: draftConfidence(fields),
    });
  },

  // No preview: even a dry fill needs the tenant account, which is only created for an approved draft.

  async execute(ctx, approved, idempotencyKey) {
    const draft = applicationDraftSchema.parse(approved.draft);
    if (draft.missingRequired.length) throw new Error(`required questions unanswered: ${draft.missingRequired.join(', ')}`);
    return run(ctx, draft, idempotencyKey, !ctx.dryRun);
  },
});

interface Run {
  ctx: PluginContext<WorkdayApplyConfig>;
  page: BrowserPage;
  board: WorkdayBoard;
  tenant: TenantOverride | undefined;
  screenshots: string[];
  shot: (name: string) => string;
}

async function run(ctx: PluginContext<WorkdayApplyConfig>, draft: ApplicationDraft, prefix: string, live: boolean): Promise<ApplicationResult> {
  const dir = resolve(ctx.config.screenshotDir);
  await mkdir(dir, { recursive: true });
  const board = parseWorkdayUrl(new URL(draft.applyUrl));
  const r: Run = {
    ctx,
    page: await ctx.browser!.newPage(),
    board,
    tenant: ctx.config.tenants[board.tenant],
    screenshots: [],
    shot: (name) => `${dir}/${prefix.replace(/[^a-z0-9-]+/gi, '_')}-${name}.png`,
  };
  const { page } = r;
  try {
    await page.goto(draft.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(ctx.config.stepWaitMs);
    await signIn(r, draft);

    const resume = draft.fields.find((f) => f.key === 'resume');
    const autofill = r.tenant?.autofill ?? true;
    if (autofill && resume?.value) {
      // "Autofill with Resume": upload, let Workday parse it, continue; the steps below correct what it got wrong.
      const upload = await firstVisible(page, resume.selectors).catch(() => null);
      await page.setInputFiles(upload ?? resume.selectors[0]!, resume.value);
      await page.waitForTimeout(ctx.config.stepWaitMs);
      await snap(r, 'autofill');
      await clickNext(r, 'Autofill with Resume');
    }

    let previous: string | null = null;
    for (let i = 0; i < ctx.config.maxSteps; i++) {
      const html = await page.content();
      if (CAPTCHA.test(html)) throw new SessionBlockedError('Workday asked for a captcha; apply by hand', 'captcha', page.url());
      const step = activeStep(html);
      if (!step) {
        await recordFailure(r, 'unknown', 'no wizard step found on the page');
        throw new Error('could not tell which Workday step is showing (layout not recognised); see the failure capture');
      }
      if (step === 'Review') {
        await snap(r, 'review');
        if (!live) return { dryRun: true, submitted: false, confirmation: null, screenshots: r.screenshots, at: new Date().toISOString() };
        return await submitAndConfirm(page, { submit: sels(r.tenant, 'submit'), confirmation: CONFIRMATION, confirmTimeoutMs: ctx.config.confirmTimeoutMs }, r.screenshots, r.shot);
      }
      if (step === previous) {
        const errors = [...html.matchAll(/data-automation-id="(?:errorMessage|errorBanner|inputAlert)"[^>]*>([\s\S]*?)<\/(?:div|span|p|li)>/gi)].map((m) => m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
        await recordFailure(r, step, `Workday did not accept the step: ${errors.join('; ') || 'no error shown'}`);
        throw new Error(`Workday did not accept "${step}": ${errors.join('; ') || 'it stayed on the same step'}; see the failure capture`);
      }
      previous = step;
      await fillStep(r, draft, step, autofill);
      await snap(r, stepSlug(step));
      await clickNext(r, step);
    }
    throw new Error(`no Review step after ${ctx.config.maxSteps} steps`);
  } finally {
    await page.close();
  }
}

async function snap(r: Run, name: string): Promise<void> {
  r.screenshots.push(r.shot(name));
  await r.page.screenshot({ path: r.screenshots.at(-1)!, fullPage: true });
}

async function clickNext(r: Run, step: string): Promise<void> {
  const next = await firstVisible(r.page, sels(r.tenant, 'next'));
  if (!next) {
    await recordFailure(r, step, 'no "Save and Continue" button');
    throw new Error(`no "Save and Continue" button on "${step}"; see the failure capture`);
  }
  await r.page.click(next);
  await r.page.waitForTimeout(r.ctx.config.stepWaitMs);
}

/**
 * Sign in to the tenant, or create its account. The password is generated and
 * stored in the keychain before the account is created, so a crash in between
 * never loses it. A verification email is confirmed through its link.
 */
async function signIn(r: Run, draft: ApplicationDraft): Promise<void> {
  const { page, ctx, board } = r;
  if (!(await firstVisible(page, sels(r.tenant, 'password')))) return; // no login wall
  if (!ctx.credentials) throw new Error('signing in to Workday needs the credentials permission');
  const email = r.ctx.gmail?.address;
  if (!email) throw new Error('Workday accounts use your Gmail address; connect Gmail (`jf gmail auth`)');
  const account = `${board.host}/${board.tenant}:${email}`;
  let password = await ctx.credentials.get(account);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (password) {
      if (await firstVisible(page, sels(r.tenant, 'verifyPassword'))) await clickFirst(r, 'signInLink', 'the Sign In link');
      await fillFirst(r, 'email', email);
      await fillFirst(r, 'password', password);
      await clickFirst(r, 'signInSubmit', 'the Sign In button');
    } else {
      if (!(await firstVisible(page, sels(r.tenant, 'verifyPassword')))) await clickFirst(r, 'createAccountLink', 'the Create Account link');
      password = await ctx.credentials.create(account);
      ctx.emit?.('account_created', { tenant: board.tenant, host: board.host });
      await fillFirst(r, 'email', email);
      await fillFirst(r, 'password', password);
      await fillFirst(r, 'verifyPassword', password);
      const box = await firstVisible(page, sels(r.tenant, 'createAccountCheckbox'));
      if (box) await page.check(box);
      await clickFirst(r, 'createAccountSubmit', 'the Create Account button');
    }
    const since = new Date();
    await page.waitForTimeout(ctx.config.stepWaitMs);
    const html = await page.content();
    if (CAPTCHA.test(html)) throw new SessionBlockedError(`Workday (${board.tenant}) asked for a captcha at sign-in; apply by hand`, 'captcha', page.url());
    if (VERIFY_PROMPT.test(html)) {
      await snap(r, 'verify-email');
      if (!ctx.gmail?.search) throw new Error('Workday sent a verification email, and reading it needs the gmail read permission');
      const got = await waitForOtp(ctx.gmail, { fromDomains: OTP_DOMAINS, since, want: 'link', timeoutMs: ctx.config.verifyTimeoutMs });
      await page.goto(got.link!, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(ctx.config.stepWaitMs);
      await page.goto(draft.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(ctx.config.stepWaitMs);
      if (!(await firstVisible(page, sels(r.tenant, 'password')))) return;
      continue; // verified: sign in with the stored password
    }
    if (!(await firstVisible(page, sels(r.tenant, 'password')))) return; // signed in
    await snap(r, 'sign-in-failed');
    const reason = ACCOUNT_EXISTS.test(html)
      ? `an account for ${email} already exists on ${board.host}/${board.tenant} with a password JobForge doesn't have; sign in (or reset the password) by hand`
      : `could not sign in to ${board.host}/${board.tenant}; check the sign-in screenshot`;
    throw new SessionBlockedError(reason, 'login', page.url());
  }
  throw new SessionBlockedError(`still not signed in to ${board.host}/${board.tenant} after verifying the account`, 'login', page.url());
}

async function fillFirst(r: Run, key: SelectorKey, value: string): Promise<void> {
  const sel = await firstVisible(r.page, sels(r.tenant, key));
  if (!sel) {
    await recordFailure(r, 'sign-in', `no ${key} field`);
    throw new Error(`no ${key} field on the Workday sign-in page; see the failure capture`);
  }
  await r.page.fill(sel, value);
}

async function clickFirst(r: Run, key: SelectorKey, what: string): Promise<void> {
  const sel = await firstVisible(r.page, sels(r.tenant, key));
  if (!sel) {
    await recordFailure(r, 'sign-in', `no ${what}`);
    throw new Error(`no ${what} on the Workday sign-in page; see the failure capture`);
  }
  await r.page.click(sel);
}

/** Fill the draft's answers for this step, then stop on any required question it doesn't answer. */
async function fillStep(r: Run, draft: ApplicationDraft, step: string, autofill: boolean): Promise<void> {
  const { page } = r;
  const slug = stepSlug(step);
  const here = draft.fields.filter((f) => f.value && (f.key.startsWith(`${slug}:`) || (f.key === 'resume' && !autofill && slug === MY_EXP)));
  const missing: string[] = [];
  const plain: ApplicationField[] = [];
  for (const f of here) {
    if (f.selectors[0]!.startsWith('button') && (f.kind === 'select' || f.kind === 'radio')) {
      if (!(await chooseListbox(r, f))) missing.push(f.label);
    } else plain.push(f);
  }
  missing.push(...(await fillForm(page, { ...draft, fields: plain }, { typingDelayMs: r.ctx.config.typingDelayMs })));
  if (missing.length) {
    await recordFailure(r, step, `fields not found: ${missing.join(', ')}`);
    throw new Error(`could not find these fields on "${step}": ${missing.join(', ')}; see the failure capture`);
  }
  const known = new Set(draft.fields.map((f) => f.key));
  const discovered = [...((await page.describeForm?.()) ?? []), ...listboxFields(await page.content())];
  const unknown = discovered.filter((f) => f.required && !f.value && f.label.trim() && !known.has(questionKey(step, f.label)));
  if (unknown.length) {
    await snap(r, `${slug}-questions`);
    throw new UnansweredQuestionsError(unknown.map((f) => discoveredQuestion(step, f)));
  }
}

/** A Workday dropdown: open it, pick the option. */
async function chooseListbox(r: Run, f: ApplicationField): Promise<boolean> {
  const btn = await firstVisible(r.page, f.selectors);
  if (!btn) return false;
  await r.page.click(btn);
  await r.page.waitForTimeout(500);
  const opt = await firstVisible(
    r.page,
    sels(r.tenant, 'option').map((s) => s.replace('%s', f.value!.replace(/"/g, '\\"'))),
  );
  if (!opt) return false;
  await r.page.click(opt);
  return true;
}

/** Keep the page as it was when a step failed: the reproducing fixture for a tenant override or fix. */
async function recordFailure(r: Run, step: string, reason: string): Promise<void> {
  try {
    const dir = resolve(r.ctx.config.failureDir, r.board.tenant.replace(/[^a-z0-9_-]+/gi, '_'));
    await mkdir(dir, { recursive: true });
    const base = `${dir}/${new Date().toISOString().replace(/[:.]/g, '-')}-${stepSlug(step) || 'step'}`;
    await writeFile(`${base}.html`, await r.page.content());
    await r.page.screenshot({ path: `${base}.png`, fullPage: true });
    r.screenshots.push(`${base}.png`);
    r.ctx.emit?.('step_failed', { tenant: r.board.tenant, host: r.board.host, step, reason, html: `${base}.html`, url: r.page.url() });
  } catch (err) {
    r.ctx.log.warn({ err: (err as Error).message }, 'could not record the Workday failure');
  }
}
