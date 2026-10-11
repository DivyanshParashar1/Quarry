import { z } from 'zod';
import {
  applicationDraftSchema,
  consentQuestion,
  defineActorPlugin,
  draftConfidence,
  mapAnswers,
  parseTaleoToken,
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

// Phase 21: Taleo (Oracle Taleo Enterprise career sections) apply, best effort.
// prepare has no side effects and no network: the apply URL is the job's
// jobdetail.ftl → jobapply.ftl. execute (approved draft only) runs the shared
// account wizard: jobapply.ftl redirects to the career section's login page
// (recorded: fixtures/aa224-login.html) → sign in, or "New User" → register
// with a keychain password → the privacy agreement (only with your consent) →
// the flow's pages (Resume Upload, General Profile, questionnaires, …) →
// "Review and Submit": stop there on a dry run, Submit live. Every tenant
// configures its flow differently; a page it can't place raises an attention
// item with screenshots instead of guessing.

export const PLUGIN_ID = 'actor-apply-taleo';
export const OTP_DOMAINS = ['taleo.net'];

export const SELECTORS: WizardSpec['selectors'] = {
  start: [],
  // Login form (recorded); registration form (synthetic until Phase 23).
  username: ['#dialogTemplate-dialogForm-login-name1', '#dialogTemplate-dialogForm-userName'],
  password: ['#dialogTemplate-dialogForm-login-password', '#dialogTemplate-dialogForm-password'],
  verifyPassword: ['#dialogTemplate-dialogForm-passwordConfirm'],
  createAccountLink: ['#dialogTemplate-dialogForm-login-register'],
  signInLink: ['#dialogTemplate-dialogForm-loginLink'],
  createAccountSubmit: ['#dialogTemplate-dialogForm-defaultCmd'],
  signInSubmit: ['#dialogTemplate-dialogForm-login-defaultCmd'],
  otpInput: ['#dialogTemplate-dialogForm-verificationCode', 'input[id*="verificationCode"]'],
  otpSubmit: ['#dialogTemplate-dialogForm-verifyCmd', 'input[value="Verify"]'],
  agreementCheckbox: ['#dialogTemplate-dialogForm-privacyAgreementAccepted'],
  agreementAccept: ['#et-ef-content-ftf-legalDisclaimerAcceptButton', 'input[value="I Accept"]', 'input[value="Accept"]'],
  next: ['#et-ef-content-ftf-saveContinueCmdBottom', 'input[value="Save and Continue"]'],
  submit: ['#et-ef-content-ftf-submitCmdBottom', 'input[value="Submit"]'],
  option: ['[role="option"]:has-text("%s")'],
};

/** Page titles of a Taleo application flow (tenants pick and rename them). */
export const STEPS = [
  'Resume Upload',
  'General Profile',
  'Basic Profile',
  'Job-Specific Questions',
  'Questionnaire',
  'Work Experience',
  'Education',
  'Diversity',
  'Voluntary Self-Identification',
  'eSignature',
  'Review and Submit',
] as const;

export const configSchema = z
  .object({
    ...wizardConfigShape('data/apply-failures/taleo'),
    /** Per-tenant overrides, keyed by the Taleo tenant (the host's first label, e.g. "aa224"). */
    tenants: z.record(z.string(), wizardTenantSchema.extend({ steps: z.array(z.string().min(1)).default([]) })).default({}),
  })
  .strict();
export type TaleoApplyConfig = z.infer<typeof configSchema>;

export const CONFIRMATION = /thank you for (applying|your application|submitting)|application (has been|was) (successfully )?(submitted|received)|successfully submitted/i;

/** jobdetail.ftl (what the source stores) → jobapply.ftl for the same job. */
export function applyUrlFor(jobUrl: string): string {
  const u = new URL(jobUrl);
  if (!u.hostname.endsWith('.taleo.net') || !/\/careersection\/[^/]+\/job(detail|apply)\.ftl$/.test(u.pathname)) throw new Error(`not a Taleo job URL: ${jobUrl}`);
  const job = u.searchParams.get('job');
  if (!job) throw new Error(`no job= in ${jobUrl}`);
  u.pathname = u.pathname.replace(/job(detail|apply)\.ftl$/, 'jobapply.ftl');
  u.search = `?job=${encodeURIComponent(job)}&lang=en`;
  return u.href;
}

/** The flow page showing: its title element, else a heading naming a known (or the tenant's) step. */
export function taleoStep(html: string, extra: readonly string[] = []): string | null {
  const names = [...extra, ...STEPS];
  const title = html.match(/id="[^"]*flowTitle[^"]*"[^>]*>([\s\S]*?)<\//i)?.[1];
  const texts = [title, ...[...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => m[1])]
    .filter((t): t is string => !!t)
    .map((t) => t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  for (const t of texts) {
    const hit = names.find((n) => t.toLowerCase() === n.toLowerCase() || t.toLowerCase().startsWith(`${n.toLowerCase()} `));
    if (hit) return hit;
  }
  return null;
}

export function taleoSpec(extraSteps: readonly string[] = []): WizardSpec {
  return {
    name: 'Taleo',
    otpDomains: OTP_DOMAINS,
    selectors: SELECTORS,
    createAccountForm: [
      { selectors: ['#dialogTemplate-dialogForm-email'], value: 'email' },
      { selectors: ['#dialogTemplate-dialogForm-emailConfirm'], value: 'email' },
    ],
    stepOf: (html) => taleoStep(html, extraSteps),
    isReview: (step) => /review|summary/i.test(step),
    resumeStep: (step) => /resume|attachment/i.test(step),
    confirmation: CONFIRMATION,
    errorPattern: /class="[^"]*\b(?:errorMessage|error-message|fieldError)\b[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p|li)>/gi,
  };
}

const GP = stepSlug('General Profile');

export function baseQuestions(tenant: WizardTenant | undefined, company: string): FormQuestion[] {
  return [
    { key: 'resume', label: 'Resume', kind: 'file', required: true, selectors: ['input[type="file"]'] },
    consentQuestion(company, 'Taleo'),
    { key: `${GP}:first_name`, label: 'First Name', kind: 'text', required: true, selectors: ['input[id$="personal_info_FirstName"]'] },
    { key: `${GP}:last_name`, label: 'Last Name', kind: 'text', required: true, selectors: ['input[id$="personal_info_LastName"]'] },
    { key: `${GP}:email`, label: 'Email Address', kind: 'text', required: true, selectors: ['input[id$="personal_info_EmailAddress"]'] },
    { key: `${GP}:phone`, label: 'Cellular Phone', kind: 'text', required: false, selectors: ['input[id$="personal_info_MobilePhone"]'] },
    { key: `${GP}:city`, label: 'City', kind: 'text', required: false, selectors: ['input[id$="personal_info_City"]'] },
    ...tenantQuestions(tenant),
  ];
}

export default defineActorPlugin<TaleoApplyConfig, ApplyInput, ApplicationDraft, ApplicationResult>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.1.0',
    stage: 'actor',
    description: 'Fills a Taleo career-section application (tenant account, flow pages) from your profile; submits only after approval. Best effort.',
    configSchema,
    permissions: { domains: ['*.taleo.net'], browser: true, gmail: ['read'], credentials: true },
    rateLimit: { perDomain: { tokens: 1, intervalMs: 2000 } },
    sideEffects: 'external',
  },

  // No side effects and no network: the job's detail page is rendered client-side.
  async prepare(ctx, input) {
    const board = parseTaleoToken(input.boardToken);
    const tenant = ctx.config.tenants[board.tenant];
    const { fields } = mapAnswers(baseQuestions(tenant, input.job.company), input);
    return applicationDraftSchema.parse({
      channel: 'apply',
      ats: 'taleo',
      title: input.job.title,
      company: input.job.company,
      jobUrl: input.applyUrl,
      applyUrl: applyUrlFor(input.applyUrl),
      resumePath: input.resume.path,
      resumeVariantId: input.resume.resumeVariantId,
      fields,
      missingRequired: fields.filter((f) => f.required && !f.value).map((f) => f.label),
      confidence: draftConfidence(fields),
    });
  },

  // No preview: the flow is behind the tenant account, created only for an approved draft.

  async execute(ctx, approved, idempotencyKey) {
    const draft = applicationDraftSchema.parse(approved.draft);
    if (draft.missingRequired.length) throw new Error(`required questions unanswered: ${draft.missingRequired.join(', ')}`);
    const host = new URL(draft.applyUrl).hostname;
    const tenant = host.split('.')[0]!;
    const override = ctx.config.tenants[tenant];
    return runAccountWizard(ctx, taleoSpec(override?.steps), { draft, tenant, host, override, live: !ctx.dryRun, prefix: idempotencyKey });
  },
});
