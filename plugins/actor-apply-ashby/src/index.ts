import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  applicationDraftSchema,
  defineActorPlugin,
  draftConfidence,
  mapAnswers,
  runApplyFlow,
  type ApplicationDraft,
  type ApplicationResult,
  type ApplyInput,
  type FieldKind,
  type FormQuestion,
} from '@jobforge/plugin-sdk';

export const PLUGIN_ID = 'actor-apply-ashby';
const HOST = 'jobs.ashbyhq.com';
export const GRAPHQL_URL = `https://${HOST}/api/non-user-graphql?op=ApiJobPosting`;

export const configSchema = z
  .object({
    screenshotDir: z.string().default('data/screenshots/apply'),
    typingDelayMs: z.number().int().min(0).default(35),
    confirmTimeoutMs: z.number().int().min(0).default(20_000),
  })
  .strict();
export type AshbyApplyConfig = z.infer<typeof configSchema>;

export function applicationUrl(org: string, id: string): string {
  return `https://${HOST}/${encodeURIComponent(org)}/${encodeURIComponent(id)}/application`;
}

const QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id title
    applicationForm { sections { title fieldEntries { ... on FormFieldEntry { id field isRequired } } } }
  }
}`;

export function graphqlBody(org: string, id: string): string {
  return JSON.stringify({ operationName: 'ApiJobPosting', variables: { organizationHostedJobsPageName: org, jobPostingId: id }, query: QUERY });
}

const ashbyField = z
  .object({
    path: z.string(),
    title: z.string(),
    type: z.string(),
    selectableValues: z.array(z.object({ label: z.string(), value: z.string() }).passthrough()).nullable().optional(),
  })
  .passthrough();
const response = z.object({
  data: z.object({
    jobPosting: z
      .object({
        applicationForm: z.object({
          sections: z.array(z.object({ title: z.string().nullable().optional(), fieldEntries: z.array(z.object({ field: ashbyField, isRequired: z.boolean().optional() }).passthrough()) })),
        }),
      })
      .nullable(),
  }),
});

const KIND: Record<string, FieldKind> = {
  String: 'text',
  Email: 'text',
  Phone: 'text',
  Number: 'text',
  Date: 'text',
  Location: 'text',
  LongText: 'textarea',
  File: 'file',
  ValueSelect: 'radio',
  Boolean: 'radio',
};

const EEO_PATH: [RegExp, NonNullable<FormQuestion['eeo']>][] = [
  [/gender/i, 'gender'],
  [/race|ethnic/i, 'race'],
  [/veteran/i, 'veteran_status'],
  [/disabilit/i, 'disability_status'],
  [/pronoun/i, 'pronouns'],
];

export function parseForm(body: unknown): FormQuestion[] {
  const r = response.parse(body);
  if (!r.data.jobPosting) throw new Error('Ashby returned no job posting (closed, or wrong id)');
  const out: FormQuestion[] = [];
  for (const section of r.data.jobPosting.applicationForm.sections) {
    const eeoSection = /eeo|voluntary|self.?identif|demographic/i.test(section.title ?? '');
    for (const { field, isRequired } of section.fieldEntries) {
      const kind = KIND[field.type];
      if (!kind) continue;
      // UUID paths can start with a digit, so use attribute selectors rather than #id.
      const selectors =
        kind === 'radio'
          ? [`input[name="${field.path}"][value="%s"]`]
          : kind === 'file'
            ? [`input[type="file"][id="${field.path}"]`, `input[type="file"][name="${field.path}"]`]
            : [`[id="${field.path}"]`, `[name="${field.path}"]`];
      const options = field.type === 'Boolean' ? ['Yes', 'No'] : field.selectableValues?.map((v) => v.label);
      const label = field.path === '_systemfield_resume' ? 'Resume' : field.title;
      const eeo = eeoSection ? EEO_PATH.find(([re]) => re.test(`${field.path} ${field.title}`))?.[1] : undefined;
      out.push({ key: field.path, label, kind, required: !!isRequired, ...(options?.length ? { options } : {}), selectors, ...(eeo ? { eeo } : {}) });
    }
  }
  return out;
}

export const CONFIRMATION = /thanks for applying|application (was )?(successfully )?submitted|we('|’)ve received your application/i;
export const SUBMIT = ['button:has-text("Submit Application")', 'button[type="submit"]'];

export default defineActorPlugin<AshbyApplyConfig, ApplyInput, ApplicationDraft, ApplicationResult>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.1.0',
    stage: 'actor',
    description: 'Fills an Ashby application form from your profile and tailored resume; submits only after approval.',
    configSchema,
    permissions: { domains: [HOST], browser: true },
    rateLimit: { perDomain: { tokens: 1, intervalMs: 2000 } },
    sideEffects: 'external',
  },

  // A read-only GraphQL query for the form definition; nothing is submitted.
  async prepare(ctx, input) {
    const body = await ctx.http.getJson(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: graphqlBody(input.boardToken, input.postingId),
    });
    const { fields, missingRequired } = mapAnswers(parseForm(body), input);
    return applicationDraftSchema.parse({
      channel: 'apply',
      ats: 'ashby',
      title: input.job.title,
      company: input.job.company,
      jobUrl: input.applyUrl,
      applyUrl: applicationUrl(input.boardToken, input.postingId),
      resumePath: input.resume.path,
      resumeVariantId: input.resume.resumeVariantId,
      fields,
      missingRequired,
      confidence: draftConfidence(fields),
    });
  },

  async preview(ctx, draft) {
    const dir = resolve(ctx.config.screenshotDir);
    await mkdir(dir, { recursive: true });
    const page = await ctx.browser!.newPage();
    try {
      return (await runApplyFlow(page, applicationDraftSchema.parse(draft), { submit: SUBMIT, confirmation: CONFIRMATION, screenshotDir: dir, prefix: `preview-${Date.now()}`, submitForReal: false })).screenshots;
    } finally {
      await page.close();
    }
  },

  async execute(ctx, approved, idempotencyKey) {
    const draft = applicationDraftSchema.parse(approved.draft);
    if (draft.missingRequired.length) throw new Error(`required questions unanswered: ${draft.missingRequired.join(', ')}`);
    const dir = resolve(ctx.config.screenshotDir);
    await mkdir(dir, { recursive: true });
    const page = await ctx.browser!.newPage();
    try {
      return await runApplyFlow(page, draft, {
        submit: SUBMIT,
        confirmation: CONFIRMATION,
        screenshotDir: dir,
        prefix: idempotencyKey,
        submitForReal: !ctx.dryRun,
        typingDelayMs: ctx.config.typingDelayMs,
        confirmTimeoutMs: ctx.config.confirmTimeoutMs,
      });
    } finally {
      await page.close();
    }
  },
});
