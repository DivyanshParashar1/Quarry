import { z } from 'zod';
import { defineEnricherPlugin, type DeadlineEstimate, type Job } from '@jobforge/plugin-sdk';

export const configSchema = z
  .object({
    /** The graduating batch the user is hiring into (internships / new-grad cycles). */
    batch: z.string().default('2027'),
    /** Without a web search the estimate is a guess; cap its confidence. */
    noSearchMaxConfidence: z.number().min(0).max(1).default(0.35),
    /** Searched but cited nothing: cap. */
    uncitedMaxConfidence: z.number().min(0).max(1).default(0.5),
  })
  .strict();
export type DeadlineConfig = z.infer<typeof configSchema>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const outputSchema = z.object({
  deadline: z
    .string()
    .regex(ISO_DATE, 'deadline must be YYYY-MM-DD')
    .refine((d) => !Number.isNaN(Date.parse(d)), 'not a real date')
    .nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(10).max(1500),
  sources: z.array(z.string().url()).max(10),
});

export const SYSTEM_PROMPT = `You estimate when job applications close, for a candidate deciding how urgently to apply.

Use web search. Look for: the posting's own stated deadline; this employer's previous cycles for the same kind of role (e.g. "Walmart Global Tech India SDE intern 2026 applications closed"); campus/off-campus drive timelines in the employer's country; forum or news reports with dates.

Rules:
- Return the most likely close date as YYYY-MM-DD, or null if you truly can't estimate.
- Cite the URLs you actually used in "sources". Never invent URLs.
- "confidence" 0..1 reflects evidence quality: an explicit posted deadline ≈ 0.9+, a clear multi-year pattern ≈ 0.6-0.8, a general industry norm ≈ 0.3-0.5.
- Rolling postings with no history: estimate from typical time-open for this employer/role and say so.
- Keep "rationale" to a few sentences: what evidence, what pattern, why this date.`;

export function deadlinePrompt(job: Job, companyName: string, cfg: DeadlineConfig, today: Date): string {
  return [
    `Today: ${today.toISOString().slice(0, 10)}`,
    `Company: ${companyName}`,
    `Role: ${job.title}`,
    `Locations: ${job.locations.join('; ') || 'n/a'}`,
    `Seniority: ${job.seniority ?? 'n/a'}`,
    `Target batch: ${cfg.batch} graduates`,
    job.postedAt ? `Posted: ${job.postedAt.toISOString().slice(0, 10)}` : 'Posted: unknown',
    job.applyUrl ? `Posting URL: ${job.applyUrl}` : '',
    '',
    'Description excerpt:',
    (job.descriptionMd ?? '(none)').slice(0, 2500),
    '',
    `Question: Given this company + role + the ${cfg.batch} batch, what is the typical application close date? Use web search. Cite sources.`,
  ].join('\n');
}

export default defineEnricherPlugin<DeadlineConfig, DeadlineEstimate>({
  manifest: {
    id: 'enricher-deadline',
    version: '0.1.0',
    stage: 'enricher',
    description: 'Estimates when applications for a job close (LLM with web search), with cited sources and a confidence.',
    configSchema,
    permissions: { domains: [], llm: true },
    sideEffects: 'none',
  },

  async enrich(ctx, job, company) {
    if (!job) throw new Error('enricher-deadline needs a job');
    const res = await ctx.llm!.generate({
      task: 'research',
      system: SYSTEM_PROMPT,
      prompt: deadlinePrompt(job, company.name, ctx.config, new Date()),
      schema: outputSchema,
      maxTokens: 1500,
      webSearch: true,
      signal: ctx.signal,
    });
    const searched = res.webSearch?.used ?? false;
    const sources = [...new Set([...res.data.sources, ...(res.webSearch?.citations ?? [])])].filter((u) => /^https?:\/\//.test(u)).slice(0, 10);
    let confidence = res.data.confidence;
    let rationale = res.data.rationale;
    if (!searched) {
      confidence = Math.min(confidence, ctx.config.noSearchMaxConfidence);
      rationale = `(estimated without web search) ${rationale}`;
    } else if (!sources.length) {
      confidence = Math.min(confidence, ctx.config.uncitedMaxConfidence);
    }
    if (res.data.deadline === null) confidence = 0;
    return { deadline: res.data.deadline, confidence: Math.round(confidence * 100) / 100, rationale, sources, searched };
  },
});
