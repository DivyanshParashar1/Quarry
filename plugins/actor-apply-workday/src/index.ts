import { z } from 'zod';
import {
  applicationDraftSchema,
  consentQuestion,
  defineActorPlugin,
  detailApiUrl,
  draftConfidence,
  mapAnswers,
  parseWorkdayToken,
  parseWorkdayUrl,
  runAccountWizard,
  stepSlug,
  tenantQuestions,
  wizardConfigShape,
  wizardTenantSchema,
  type ApplicationDraft,
  type ApplicationResult,
  type ApplyInput,
  type FormQuestion,
  type WizardSpec,
} from '@quarry/plugin-sdk';

export { listboxFields, questionKey, stepSlug } from '@quarry/plugin-sdk';

// Phase 20: Workday apply. Every tenant is its own site with its own candidate
// account. prepare: GET the posting from the public CXS API (no side effects),
// then the fields every Workday wizard has plus the tenant's learned questions →
// deterministic mapping. execute (approved draft only) runs the shared account
// wizard (plugin-sdk/wizard.ts) on {job}/apply/autofillWithResume: sign in or
// create the tenant account, upload the resume on "Autofill with Resume" (or on
// My Experience for "Apply Manually" tenants), walk My Information → … → Review,
// stop there on a dry run, Submit live.

export const PLUGIN_ID = 'actor-apply-workday';
export const OTP_DOMAINS = ['myworkday.com', 'myworkdayjobs.com', 'myworkdaysite.com'];

export const SELECTORS: WizardSpec['selectors'] = {
  start: [],
  username: ['input[data-automation-id="email"]'],
  password: ['input[data-automation-id="password"]'],
  verifyPassword: ['input[data-automation-id="verifyPassword"]'],
  createAccountLink: ['button[data-automation-id="createAccountLink"]'],
  signInLink: ['button[data-automation-id="signInLink"]'],
  createAccountSubmit: ['button[data-automation-id="createAccountSubmitButton"]', 'div[data-automation-id="click_filter"][aria-label="Create Account"]'],
  signInSubmit: ['button[data-automation-id="signInSubmitButton"]', 'div[data-automation-id="click_filter"][aria-label="Sign In"]'],
  otpInput: [],
  otpSubmit: [],
  agreementCheckbox: ['input[data-automation-id="createAccountCheckbox"]'],
  agreementAccept: [],
  next: ['button[data-automation-id="bottom-navigation-next-button"]'],
  submit: ['button[data-automation-id="bottom-navigation-next-button"]:has-text("Submit")', 'button:has-text("Submit")'],
  option: ['[role="option"]:has-text("%s")', 'div[data-automation-id="promptOption"]:has-text("%s")'],
};

const tenantSchema = wizardTenantSchema.extend({
  /** false = "Apply Manually" (no resume autofill); the resume is uploaded on My Experience instead. */
  autofill: z.boolean().default(true),
});
export type TenantOverride = z.infer<typeof tenantSchema>;

export const configSchema = z
  .object({
    ...wizardConfigShape('data/apply-failures/workday'),
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
export const STEPS = ['My Information', 'My Experience', 'Application Questions', 'Voluntary Disclosures', 'Self Identify', 'Review'] as const;

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

export function workdaySpec(autofill: boolean): WizardSpec {
  return {
    name: 'Workday',
    otpDomains: OTP_DOMAINS,
    selectors: SELECTORS,
    createAccountForm: [],
    stepOf: activeStep,
    isReview: (step) => step === 'Review',
    // "Autofill with Resume": Workday parses the upload and prefills; the steps after it correct what it got wrong.
    resumeStep: (step) => (autofill ? /autofill with resume/i.test(step) : step === 'My Experience'),
    confirmation: CONFIRMATION,
    errorPattern: /data-automation-id="(?:errorMessage|errorBanner|inputAlert)"[^>]*>([\s\S]*?)<\/(?:div|span|p|li)>/gi,
  };
}

const MY_INFO = stepSlug('My Information');
const MY_EXP = stepSlug('My Experience');

/** Fields every Workday wizard has, your consent to the account terms, and the tenant's learned questions. */
export function baseQuestions(tenant: TenantOverride | undefined, company: string): FormQuestion[] {
  return [
    { key: 'resume', label: 'Resume/CV', kind: 'file', required: true, selectors: ['input[data-automation-id="file-upload-input-ref"]'] },
    consentQuestion(company, 'Workday'),
    { key: `${MY_INFO}:first_name`, label: 'First Name', kind: 'text', required: true, selectors: ['input[data-automation-id="legalNameSection_firstName"]'] },
    { key: `${MY_INFO}:last_name`, label: 'Last Name', kind: 'text', required: true, selectors: ['input[data-automation-id="legalNameSection_lastName"]'] },
    { key: `${MY_INFO}:city`, label: 'City', kind: 'text', required: false, selectors: ['input[data-automation-id="addressSection_city"]'] },
    { key: `${MY_INFO}:phone`, label: 'Phone Number', kind: 'text', required: true, selectors: ['input[data-automation-id="phone-number"]'] },
    { key: `${MY_EXP}:linkedin`, label: 'LinkedIn', kind: 'text', required: false, selectors: ['input[data-automation-id="linkedinQuestion"]'] },
    ...tenantQuestions(tenant),
  ];
}

export default defineActorPlugin<WorkdayApplyConfig, ApplyInput, ApplicationDraft, ApplicationResult>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.2.0',
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
    const { fields } = mapAnswers(baseQuestions(tenant, input.job.company), input);
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
    const board = parseWorkdayUrl(new URL(draft.applyUrl));
    const override = ctx.config.tenants[board.tenant];
    return runAccountWizard(ctx, workdaySpec(override?.autofill ?? true), { draft, tenant: board.tenant, host: board.host, override, live: !ctx.dryRun, prefix: idempotencyKey });
  },
});
