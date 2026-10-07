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

export const PLUGIN_ID = 'actor-apply-greenhouse';

export const configSchema = z
  .object({
    screenshotDir: z.string().default('data/screenshots/apply'),
    typingDelayMs: z.number().int().min(0).default(35),
    /** How long to wait for the "thank you" page after submitting. */
    confirmTimeoutMs: z.number().int().min(0).default(20_000),
  })
  .strict();
export type GreenhouseApplyConfig = z.infer<typeof configSchema>;

const API = 'boards-api.greenhouse.io';

export function questionsUrl(token: string, id: string): string {
  return `https://${API}/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(id)}?questions=true`;
}
/** The embeddable application form: classic markup with stable field ids. */
export function formUrl(token: string, id: string): string {
  return `https://boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(token)}&token=${encodeURIComponent(id)}`;
}

const ghField = z.object({
  name: z.string(),
  type: z.string(),
  values: z.array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]).nullable().optional() }).passthrough()).optional(),
});
const ghQuestion = z
  .object({ label: z.string(), required: z.boolean().nullable().optional(), fields: z.array(ghField) })
  .passthrough();
const ghJob = z
  .object({
    questions: z.array(ghQuestion).default([]),
    location_questions: z.array(ghQuestion).nullable().optional(),
    compliance: z.array(z.object({ type: z.string().optional(), questions: z.array(ghQuestion).default([]) }).passthrough()).nullable().optional(),
  })
  .passthrough();

const KIND: Record<string, FieldKind> = {
  input_text: 'text',
  textarea: 'textarea',
  input_file: 'file',
  multi_value_single_select: 'select',
  multi_value_multi_select: 'multiselect',
};

const EEO_LABEL: [RegExp, NonNullable<FormQuestion['eeo']>][] = [
  [/hispanic|latino/i, 'hispanic_latino'],
  [/race|ethnic/i, 'race'],
  [/gender|sex\b/i, 'gender'],
  [/veteran/i, 'veteran_status'],
  [/disabilit/i, 'disability_status'],
  [/pronoun/i, 'pronouns'],
];

function toQuestion(q: z.infer<typeof ghQuestion>, eeo: boolean): FormQuestion | null {
  // A question can offer alternatives (resume file OR pasted text); answer the first usable field.
  const f = q.fields.find((x) => KIND[x.type] && !x.name.endsWith('_text')) ?? q.fields.find((x) => KIND[x.type]);
  if (!f) return null;
  const kind = KIND[f.type]!;
  const name = f.name;
  const selectors =
    kind === 'file'
      ? [`input[type="file"]#${name}`, `#${name}`, `input[type="file"][name="${name}"]`]
      : [`#${name}`, `[name="job_application[${name}]"]`, `[name="${name}"]`];
  return {
    key: name,
    label: q.label.trim(),
    kind,
    required: !!q.required,
    ...(f.values?.length ? { options: f.values.map((v) => v.label) } : {}),
    selectors,
    ...(eeo ? { eeo: EEO_LABEL.find(([re]) => re.test(q.label))?.[1] ?? 'gender' } : {}),
  };
}

export function parseQuestions(body: unknown): FormQuestion[] {
  const job = ghJob.parse(body);
  const out: FormQuestion[] = [];
  for (const q of [...job.questions, ...(job.location_questions ?? [])]) {
    const fq = toQuestion(q, false);
    if (fq) out.push(fq);
  }
  for (const c of job.compliance ?? []) {
    for (const q of c.questions) {
      const fq = toQuestion(q, true);
      if (fq) out.push(fq);
    }
  }
  return out;
}

export const CONFIRMATION = /thank you for applying|application (has been )?(submitted|received)|we('|’)ve received your application|\/confirmation/i;
export const SUBMIT = ['#submit_app', 'button[type="submit"]', 'input[type="submit"]'];

export default defineActorPlugin<GreenhouseApplyConfig, ApplyInput, ApplicationDraft, ApplicationResult>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.1.0',
    stage: 'actor',
    description: 'Fills a Greenhouse application form from your profile and tailored resume; submits only after approval.',
    configSchema,
    permissions: { domains: [API, 'boards.greenhouse.io', 'job-boards.greenhouse.io'], browser: true },
    rateLimit: { perDomain: { tokens: 1, intervalMs: 2000 } },
    sideEffects: 'external',
  },

  // No side effects: one GET for the form's questions, then deterministic mapping.
  async prepare(ctx, input) {
    const questions = parseQuestions(await ctx.http.getJson(questionsUrl(input.boardToken, input.postingId)));
    const { fields, missingRequired } = mapAnswers(questions, input);
    return applicationDraftSchema.parse({
      channel: 'apply',
      ats: 'greenhouse',
      title: input.job.title,
      company: input.job.company,
      jobUrl: input.applyUrl,
      applyUrl: formUrl(input.boardToken, input.postingId),
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
      const r = await runApplyFlow(page, applicationDraftSchema.parse(draft), { submit: SUBMIT, confirmation: CONFIRMATION, screenshotDir: dir, prefix: `preview-${Date.now()}`, submitForReal: false });
      return r.screenshots;
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
      // Dry run fills and screenshots but never clicks submit (PLAN Phase 11).
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
