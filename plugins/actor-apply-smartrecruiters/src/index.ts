import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  applicationDraftSchema,
  defineActorPlugin,
  draftConfidence,
  fillForm,
  mapAnswers,
  submitAndConfirm,
  UnansweredQuestionsError,
  waitForOtp,
  type ApplicationDraft,
  type ApplicationResult,
  type ApplyInput,
  type BrowserPage,
  type DiscoveredField,
  type FormQuestion,
  type PluginContext,
} from '@jobforge/plugin-sdk';

// Phase 19: SmartRecruiters one-click apply. Recorded from a real public posting
// (fixtures/README.md): the form is a web-components app at
// jobs.smartrecruiters.com/oneclick-ui/company/{identifier}/publication/{uuid}.
//   prepare: GET the posting (uuid), GET the form page (the company's internal
//   id is embedded), GET the form config (which step-1 field sets are visible /
//   required) → questions → deterministic mapping. No side effects.
//   execute: fill step 1; a dry run stops there (never presses "Next"). Live:
//   "Next" → read the next step's fields; a required question the draft has no
//   answer for stops the run (UnansweredQuestionsError — nothing submitted) and
//   the core sends it back for review; otherwise fill and submit, entering an
//   emailed verification code if one is asked for.

export const PLUGIN_ID = 'actor-apply-smartrecruiters';
const API = 'api.smartrecruiters.com';
const JOBS = 'jobs.smartrecruiters.com';

export const configSchema = z
  .object({
    screenshotDir: z.string().default('data/screenshots/apply'),
    typingDelayMs: z.number().int().min(0).default(35),
    confirmTimeoutMs: z.number().int().min(0).default(30_000),
    /** Safety stop for unusually long wizards. */
    maxSteps: z.number().int().min(1).max(8).default(4),
  })
  .strict();
export type SmartRecruitersApplyConfig = z.infer<typeof configSchema>;

export const postingUrl = (company: string, id: string) => `https://${API}/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`;
export const formUrl = (identifier: string, uuid: string) => `https://${JOBS}/oneclick-ui/company/${encodeURIComponent(identifier)}/publication/${encodeURIComponent(uuid)}`;
export const configUrl = (companyId: string, uuid: string) => `https://${JOBS}/oneclick-ui/api/company/${encodeURIComponent(companyId)}/publication/${encodeURIComponent(uuid)}/config`;

const postingSchema = z.object({ id: z.string(), uuid: z.string(), company: z.object({ identifier: z.string() }).passthrough() }).passthrough();
const flag = z.object({ required: z.boolean(), visible: z.boolean() }).passthrough().nullable().optional();
const configBody = z
  .object({
    fieldSets: z
      .object({
        firstAndLastName: flag,
        email: flag,
        placeOfResidence: flag,
        phoneNumber: flag,
        experience: flag,
        education: flag,
        socialProfiles: z.object({ visible: z.boolean(), linkedIn: flag, website: flag }).passthrough().nullable().optional(),
        resume: flag,
        messageToHiringManager: flag,
      })
      .passthrough(),
  })
  .passthrough();

/** The internal company id the form page embeds (escaped JSON in a script). */
export function parseCompanyId(html: string): string | null {
  return html.match(/\\?"company\\?"\s*:\s*\{\s*\\?"id\\?"\s*:\s*\\?"([0-9a-f]{24})\\?"/)?.[1] ?? null;
}

export const SEL = {
  next: ['oc-button[data-test="footer-next"] button', 'button:has-text("Next")'],
  submit: ['oc-button[data-test="footer-submit"] button', 'button:has-text("Submit")', 'button:has-text("Send")', 'button:has-text("Apply")'],
} as const;

export const CONFIRMATION = /thank you for (your application|applying)|your application (has been|was) (sent|submitted|received)|application (sent|submitted)|\/(confirmation|success|thank-?you)\b/i;
export const OTP_PROMPT = /verification code|verify your email|enter the code|confirm your email address/i;
export const OTP_INPUT = ['input[autocomplete="one-time-code"]', 'input[name*="code" i]', 'input[id*="code" i]'];
export const OTP_DOMAINS = ['smartrecruiters.com', 'smartrecruiters.io'];

/** Step-1 questions from the form config. Experience/education sub-forms can't be auto-filled. */
export function questionsFromConfig(body: unknown): FormQuestion[] {
  const f = configBody.parse(body).fieldSets;
  const on = (x: { visible: boolean } | null | undefined) => !!x?.visible;
  if (f.experience?.required || f.education?.required) {
    throw new Error('this SmartRecruiters form requires experience/education entries, which are filled by hand; apply to it yourself');
  }
  const q: FormQuestion[] = [];
  if (on(f.firstAndLastName)) {
    q.push({ key: 's1:first_name', label: 'First name', kind: 'text', required: true, selectors: ['#first-name-input'] });
    q.push({ key: 's1:last_name', label: 'Last name', kind: 'text', required: true, selectors: ['#last-name-input'] });
  }
  if (on(f.email)) {
    q.push({ key: 's1:email', label: 'Email', kind: 'text', required: !!f.email?.required, selectors: ['#email-input'] });
    q.push({ key: 's1:email_confirm', label: 'Confirm your email', kind: 'text', required: !!f.email?.required, selectors: ['#confirm-email-input'] });
  }
  if (on(f.placeOfResidence)) {
    q.push({ key: 's1:city', label: 'City', kind: 'text', required: !!f.placeOfResidence?.required, selectors: ['spl-autocomplete[data-test="location-autocomplete"] input', '[data-test="location-autocomplete"] input'] });
  }
  if (on(f.phoneNumber)) {
    q.push({ key: 's1:phone', label: 'Phone number', kind: 'text', required: !!f.phoneNumber?.required, selectors: ['oc-phone-number input[type="tel"]', 'input[type="tel"]'] });
  }
  if (f.socialProfiles?.visible) {
    if (on(f.socialProfiles.linkedIn)) q.push({ key: 's1:linkedin', label: 'LinkedIn', kind: 'text', required: !!f.socialProfiles.linkedIn?.required, selectors: ['#linkedin-input'] });
    if (on(f.socialProfiles.website)) q.push({ key: 's1:website', label: 'Website', kind: 'text', required: !!f.socialProfiles.website?.required, selectors: ['#website-input'] });
  }
  if (on(f.resume)) {
    q.push({ key: 's1:resume', label: 'Resume', kind: 'file', required: !!f.resume?.required, selectors: ['spl-dropzone[data-test="resume-upload"] input[type="file"]', '[data-test="resume-upload"] input[type="file"]'] });
  }
  if (on(f.messageToHiringManager)) {
    q.push({
      key: 's1:message',
      label: 'Message to the hiring team: why are you interested in working here?',
      kind: 'textarea',
      required: !!f.messageToHiringManager?.required,
      selectors: ['#hiring-manager-message-input'],
      maxLength: 2000,
    });
  }
  return q;
}

/** A field discovered on a later step → the stable key the draft stores its answer under. */
export function laterKey(label: string): string {
  return `q:${label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

const CONSENT = /consent|privacy|agree|terms|data (protection|processing)|gdpr/i;

export function discoveredQuestion(f: DiscoveredField): FormQuestion {
  return {
    key: laterKey(f.label),
    // Consent must be given explicitly by you (a required, unanswered checkbox).
    label: CONSENT.test(f.label) ? `${f.label} (consent — set Yes to agree)` : f.label,
    kind: f.kind,
    required: f.required,
    selectors: [f.selector],
    ...(f.options?.length ? { options: f.options } : {}),
    ...(f.maxLength ? { maxLength: f.maxLength } : {}),
  };
}

async function firstVisible(page: BrowserPage, selectors: readonly string[]): Promise<string | null> {
  for (const s of selectors) if (await page.isVisible(s)) return s;
  return null;
}

export default defineActorPlugin<SmartRecruitersApplyConfig, ApplyInput, ApplicationDraft, ApplicationResult>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.1.0',
    stage: 'actor',
    description: 'Fills a SmartRecruiters one-click application from your profile and tailored resume; submits only after approval.',
    configSchema,
    permissions: { domains: [API, JOBS], browser: true, gmail: ['read'] },
    rateLimit: { perDomain: { tokens: 1, intervalMs: 2000 } },
    sideEffects: 'external',
  },

  // No side effects: three GETs, then deterministic mapping.
  async prepare(ctx, input) {
    const posting = postingSchema.parse(await ctx.http.getJson(postingUrl(input.boardToken, input.postingId)));
    const url = formUrl(posting.company.identifier, posting.uuid);
    const companyId = parseCompanyId(await ctx.http.getText(url));
    if (!companyId) throw new Error(`could not read the company id from ${url}`);
    const questions = questionsFromConfig(await ctx.http.getJson(configUrl(companyId, posting.uuid)));
    const { fields } = mapAnswers(questions, input);
    // "Confirm your email" repeats the email answer.
    const email = fields.find((f) => f.key === 's1:email')?.value ?? null;
    for (const f of fields) if (f.key === 's1:email_confirm' && email) Object.assign(f, { value: email, source: 'profile' });
    return applicationDraftSchema.parse({
      channel: 'apply',
      ats: 'smartrecruiters',
      title: input.job.title,
      company: input.job.company,
      jobUrl: input.applyUrl || url,
      applyUrl: url,
      resumePath: input.resume.path,
      resumeVariantId: input.resume.resumeVariantId,
      fields,
      missingRequired: fields.filter((f) => f.required && !f.value).map((f) => f.label),
      confidence: draftConfidence(fields),
    });
  },

  async preview(ctx, draft) {
    const r = await run(ctx, applicationDraftSchema.parse(draft), `preview-${Date.now()}`, false);
    return r.screenshots;
  },

  async execute(ctx, approved, idempotencyKey) {
    const draft = applicationDraftSchema.parse(approved.draft);
    if (draft.missingRequired.length) throw new Error(`required questions unanswered: ${draft.missingRequired.join(', ')}`);
    return run(ctx, draft, idempotencyKey, !ctx.dryRun);
  },
});

async function run(ctx: PluginContext<SmartRecruitersApplyConfig>, draft: ApplicationDraft, prefix: string, live: boolean): Promise<ApplicationResult> {
  const dir = resolve(ctx.config.screenshotDir);
  await mkdir(dir, { recursive: true });
  const shot = (name: string) => `${dir}/${prefix.replace(/[^a-z0-9-]+/gi, '_')}-${name}.png`;
  const screenshots: string[] = [];
  const page = await ctx.browser!.newPage();
  try {
    await page.goto(draft.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);
    const step1 = { ...draft, fields: draft.fields.filter((f) => f.key.startsWith('s1:')) };
    const notFound = await fillForm(page, step1, { typingDelayMs: ctx.config.typingDelayMs });
    screenshots.push(shot('step1'));
    await page.screenshot({ path: screenshots.at(-1)!, fullPage: true });
    if (notFound.length) throw new Error(`could not find these fields on the form: ${notFound.join(', ')}`);
    // A dry run never leaves step 1: "Next" may already create a draft application on SmartRecruiters.
    if (!live) return { dryRun: true, submitted: false, confirmation: null, screenshots, at: new Date().toISOString() };

    for (let step = 2; step <= ctx.config.maxSteps + 1; step++) {
      const next = await firstVisible(page, SEL.next);
      if (!next) break;
      await page.click(next);
      await page.waitForTimeout(2500);
      const known = new Map(draft.fields.map((f) => [f.key, f]));
      const discovered = ((await page.describeForm?.()) ?? []).filter((f) => !f.value && f.label.trim());
      const unknown = discovered.filter((f) => !known.has(laterKey(f.label)) && f.required);
      if (unknown.length) {
        screenshots.push(shot(`step${step}-questions`));
        await page.screenshot({ path: screenshots.at(-1)!, fullPage: true });
        throw new UnansweredQuestionsError(unknown.map(discoveredQuestion));
      }
      const here = discovered.map((f) => known.get(laterKey(f.label))).filter((f): f is NonNullable<typeof f> => !!f && !!f.value);
      const missing = await fillForm(page, { ...draft, fields: here }, { typingDelayMs: ctx.config.typingDelayMs });
      screenshots.push(shot(`step${step}`));
      await page.screenshot({ path: screenshots.at(-1)!, fullPage: true });
      if (missing.length) throw new Error(`could not find these fields on step ${step}: ${missing.join(', ')}`);
    }
    return await submitAndConfirm(
      page,
      {
        submit: [...SEL.submit],
        confirmation: CONFIRMATION,
        confirmTimeoutMs: ctx.config.confirmTimeoutMs,
        ...(ctx.gmail?.search
          ? { otp: { prompt: OTP_PROMPT, input: OTP_INPUT, submit: [...SEL.submit, 'button:has-text("Verify")', 'button:has-text("Confirm")'], wait: (since: Date) => waitForOtp(ctx.gmail!, { fromDomains: OTP_DOMAINS, since }) } }
          : {}),
      },
      screenshots,
      shot,
    );
  } finally {
    await page.close();
  }
}
