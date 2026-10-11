import { z } from 'zod';
import {
  applicationDraftSchema,
  consentQuestion,
  defineActorPlugin,
  draftConfidence,
  mapAnswers,
  parseSuccessFactorsToken,
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
  type WizardTenant,
} from '@jobforge/plugin-sdk';

// Phase 21: SAP SuccessFactors apply, best effort.
//   prepare: GET the job page (no side effects). A filled posting is refused;
//   Recruiting Marketing (RMK) pages link the form as
//   /talentcommunity/apply/{jobId}/?locale=… (recorded: fixtures/cargill-job.html),
//   classic career sites show an Apply button on the job page itself.
//   execute (approved draft only): the shared account wizard — sign in or create
//   the candidate account (keychain password; the data-privacy checkbox only with
//   your consent), accept the privacy statement (same), then the application,
//   which SuccessFactors renders as ONE long page: fill it, and that filled page
//   is the review point — a dry run stops there, live presses Apply/Submit.
// Only SAP-hosted sites (*.successfactors.*, *.sapsf.*) are reachable; RMK sites
// on an employer's own domain stay manual (the manifest's domains are fixed).

export const PLUGIN_ID = 'actor-apply-successfactors';
export const OTP_DOMAINS = ['successfactors.com', 'successfactors.eu', 'sapsf.com', 'sapsf.eu'];

export const SELECTORS: WizardSpec['selectors'] = {
  // Classic career sites: the job page's own Apply button.
  start: ['a[id*="applyButton"]', 'button:has-text("Apply now")'],
  username: ['#username', '#fbclc_userName'],
  password: ['#password', '#fbclc_pwd'],
  verifyPassword: ['#fbclc_pwdConf'],
  createAccountLink: ['#createAccountLink', 'a:has-text("Create an account")'],
  signInLink: ['#signInLink'],
  createAccountSubmit: ['#fbclc_createAccountButton'],
  signInSubmit: ['#signInBtn', 'button:has-text("Sign In")'],
  otpInput: ['#verificationCode'],
  otpSubmit: ['#verifyCodeBtn'],
  agreementCheckbox: ['#dataPrivacyId'],
  agreementAccept: ['#dataPrivacyAcceptBtn', 'button:has-text("Accept")'],
  next: [],
  submit: ['#fbclc_submit', 'button:has-text("Submit")', 'button:has-text("Apply")'],
  option: ['[role="option"]:has-text("%s")'],
};

export const configSchema = z
  .object({
    ...wizardConfigShape('data/apply-failures/successfactors'),
    /** Per-tenant overrides, keyed by the RMK host (jobs.acme.sapsf.com) or the classic company id. */
    tenants: z.record(z.string(), wizardTenantSchema).default({}),
  })
  .strict();
export type SuccessFactorsApplyConfig = z.infer<typeof configSchema>;

export const CONFIRMATION = /thank you for (applying|your application)|application (has been|was) (successfully )?(submitted|received)|you have (successfully )?applied/i;
const FILLED = /position has been filled|no longer (available|accepting applications)|job (is )?(closed|expired)/i;
export const APPLICATION = 'Application';

/** Tenant key: the RMK host, or the classic site's company id. */
export function tenantKey(jobUrl: string): string {
  const b = parseSuccessFactorsToken(jobUrl);
  return b.kind === 'classic' ? b.companyId : b.host;
}

/** The form a job page links: RMK's /talentcommunity/apply/{id}/ link, else the job page itself (classic Apply button). */
export function applyUrlFrom(jobUrl: string, html: string): string {
  if (FILLED.test(html)) throw new Error('this SuccessFactors posting has been filled / is closed');
  const href = html.match(/href="([^"]*\/talentcommunity\/apply\/\d+\/[^"]*)"/i)?.[1];
  if (href) return new URL(href.replace(/&amp;/g, '&'), jobUrl).href;
  if (parseSuccessFactorsToken(jobUrl).kind === 'classic') return jobUrl;
  throw new Error('no Apply link on this SuccessFactors job page; apply by hand');
}

/** The application page is one long form headed "Apply for …" / "Application". */
export function sfStep(html: string): string | null {
  return /<h1[^>]*>\s*(apply(ing)? for\b|application\b)/i.test(html) || /id="applyForm"/i.test(html) ? APPLICATION : null;
}

export const sfSpec: WizardSpec = {
  name: 'SuccessFactors',
  otpDomains: OTP_DOMAINS,
  selectors: SELECTORS,
  createAccountForm: [
    { selectors: ['#fbclc_emailConf'], value: 'email' },
    { selectors: ['#fbclc_fName'], value: 'first_name' },
    { selectors: ['#fbclc_lName'], value: 'last_name' },
  ],
  stepOf: sfStep,
  isReview: () => false,
  reviewAfterFill: (step) => step === APPLICATION,
  resumeStep: (step) => step === APPLICATION,
  confirmation: CONFIRMATION,
  errorPattern: /class="[^"]*\b(?:error|errorMessage|alert-danger)\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p|li)>/gi,
};

const APP = stepSlug(APPLICATION);

export function baseQuestions(tenant: WizardTenant | undefined, company: string): FormQuestion[] {
  return [
    { key: 'resume', label: 'Resume', kind: 'file', required: true, selectors: ['input[type="file"]'] },
    consentQuestion(company, 'SuccessFactors'),
    { key: `${APP}:first_name`, label: 'First Name', kind: 'text', required: true, selectors: ['#firstName'] },
    { key: `${APP}:last_name`, label: 'Last Name', kind: 'text', required: true, selectors: ['#lastName'] },
    { key: `${APP}:phone`, label: 'Phone', kind: 'text', required: false, selectors: ['#cellPhone'] },
    { key: `${APP}:city`, label: 'City', kind: 'text', required: false, selectors: ['#city'] },
    ...tenantQuestions(tenant),
  ];
}

export default defineActorPlugin<SuccessFactorsApplyConfig, ApplyInput, ApplicationDraft, ApplicationResult>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.1.0',
    stage: 'actor',
    description: 'Fills a SAP SuccessFactors application (candidate account, one-page form) from your profile; submits only after approval. Best effort.',
    configSchema,
    permissions: { domains: ['*.successfactors.com', '*.successfactors.eu', '*.sapsf.com', '*.sapsf.eu'], browser: true, gmail: ['read'], credentials: true },
    rateLimit: { perDomain: { tokens: 1, intervalMs: 2000 } },
    sideEffects: 'external',
  },

  // No side effects: one GET of the job page.
  async prepare(ctx, input) {
    const jobUrl = input.applyUrl;
    const applyUrl = applyUrlFrom(jobUrl, await ctx.http.getText(jobUrl));
    const tenant = ctx.config.tenants[tenantKey(jobUrl)];
    const { fields } = mapAnswers(baseQuestions(tenant, input.job.company), input);
    return applicationDraftSchema.parse({
      channel: 'apply',
      ats: 'successfactors',
      title: input.job.title,
      company: input.job.company,
      jobUrl,
      applyUrl,
      resumePath: input.resume.path,
      resumeVariantId: input.resume.resumeVariantId,
      fields,
      missingRequired: fields.filter((f) => f.required && !f.value).map((f) => f.label),
      confidence: draftConfidence(fields),
    });
  },

  // No preview: the form is behind the candidate account, created only for an approved draft.

  async execute(ctx, approved, idempotencyKey) {
    const draft = applicationDraftSchema.parse(approved.draft);
    if (draft.missingRequired.length) throw new Error(`required questions unanswered: ${draft.missingRequired.join(', ')}`);
    const tenant = tenantKey(draft.jobUrl);
    return runAccountWizard(ctx, sfSpec, { draft, tenant, host: new URL(draft.jobUrl).hostname, override: ctx.config.tenants[tenant], live: !ctx.dryRun, prefix: idempotencyKey });
  },
});
