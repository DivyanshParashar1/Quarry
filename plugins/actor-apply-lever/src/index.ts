import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  applicationDraftSchema,
  decodeEntities,
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

export const PLUGIN_ID = 'actor-apply-lever';
const HOST = 'jobs.lever.co';

export const configSchema = z
  .object({
    screenshotDir: z.string().default('data/screenshots/apply'),
    typingDelayMs: z.number().int().min(0).default(35),
    confirmTimeoutMs: z.number().int().min(0).default(20_000),
  })
  .strict();
export type LeverApplyConfig = z.infer<typeof configSchema>;

export function applyPageUrl(company: string, id: string): string {
  return `https://${HOST}/${encodeURIComponent(company)}/${encodeURIComponent(id)}/apply`;
}

const text = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/[✱*]/g, '').replace(/\s+/g, ' ').trim();
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? null;
const css = (s: string) => s.replace(/"/g, '\\"');

const EEO: Record<string, NonNullable<FormQuestion['eeo']>> = {
  'eeo[gender]': 'gender',
  'eeo[race]': 'race',
  'eeo[veteran]': 'veteran_status',
  'eeo[disability]': 'disability_status',
  'eeo[pronouns]': 'pronouns',
};

/** Questions on Lever's hosted apply page (`<li class="application-question">` blocks). */
export function parseApplyPage(html: string): FormQuestion[] {
  const out: FormQuestion[] = [];
  const seen = new Set<string>();
  for (const block of html.split(/<li\b[^>]*class="[^"]*application-question/i).slice(1)) {
    const labelHtml = block.match(/class="[^"]*application-label[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>\s*)?(?:<div[^>]*application-field|<\/label|<div)/i)?.[1] ?? '';
    const label = text(labelHtml);
    const required = /✱|class="[^"]*required/i.test(labelHtml) || /\brequired\b/.test(block.slice(0, 2000).match(/<(input|select|textarea)\b[^>]*>/i)?.[0] ?? '');
    const tag = block.match(/<(input|select|textarea)\b[^>]*>/i);
    if (!tag) continue;
    const name = attr(tag[0], 'name');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const type = (attr(tag[0], 'type') ?? tag[1]!).toLowerCase();
    let kind: FieldKind;
    let options: string[] | undefined;
    let selectors = [`[name="${css(name)}"]`];
    if (tag[1]!.toLowerCase() === 'select') {
      kind = 'select';
      options = [...block.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)].map((m) => text(m[1]!)).filter((o) => o && !/^select\b|^--/i.test(o));
    } else if (tag[1]!.toLowerCase() === 'textarea') kind = 'textarea';
    else if (type === 'file') kind = 'file';
    else if (type === 'radio') {
      kind = 'radio';
      options = [...block.matchAll(/<input\b[^>]*type="radio"[^>]*>/gi)].map((m) => attr(m[0], 'value') ?? '').filter(Boolean);
      selectors = [`input[name="${css(name)}"][value="%s"]`];
    } else if (type === 'checkbox') kind = 'checkbox';
    else kind = 'text';
    out.push({
      key: name,
      label: label || name,
      kind,
      required,
      ...(options ? { options } : {}),
      selectors,
      ...(EEO[name] ? { eeo: EEO[name] } : {}),
    });
  }
  return out;
}

export const CONFIRMATION = /application submitted|thanks for applying|we('|’)ve received your application|\/thanks/i;
export const SUBMIT = ['#btn-submit', 'button[data-qa="btn-submit"]', 'button[type="submit"]'];

export default defineActorPlugin<LeverApplyConfig, ApplyInput, ApplicationDraft, ApplicationResult>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.1.0',
    stage: 'actor',
    description: 'Fills a Lever application form from your profile and tailored resume; submits only after approval.',
    configSchema,
    permissions: { domains: [HOST], browser: true },
    rateLimit: { perDomain: { tokens: 1, intervalMs: 2000 } },
    sideEffects: 'external',
  },

  async prepare(ctx, input) {
    const url = applyPageUrl(input.boardToken, input.postingId);
    const questions = parseApplyPage(await ctx.http.getText(url));
    if (!questions.length) throw new Error(`no application questions found on ${url}`);
    const { fields, missingRequired } = mapAnswers(questions, input);
    return applicationDraftSchema.parse({
      channel: 'apply',
      ats: 'lever',
      title: input.job.title,
      company: input.job.company,
      jobUrl: input.applyUrl,
      applyUrl: url,
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
