import { z } from 'zod';
import { defineMatcherPlugin, type Job, type MatchResult, type PluginContext, type Profile } from '@jobforge/plugin-sdk';
import { applyHardFilters } from './filters.js';
import { batchPrompt, rubricResponseSchema, SYSTEM_PROMPT, type RubricItem } from './prompt.js';

export * from './filters.js';
export * from './prompt.js';

export const configSchema = z
  .object({
    /** Jobs whose cosine similarity to the profile is below this are not sent to the LLM. */
    minSimilarity: z.number().min(-1).max(1).default(0.55),
    /** At most this many jobs per run go to the LLM, highest similarity first. */
    llmTopK: z.number().int().positive().default(150),
    /** Jobs per LLM call. */
    batchSize: z.number().int().min(1).max(30).default(12),
    /** Description characters sent per job. */
    descriptionChars: z.number().int().min(200).default(3000),
    experienceSlackYears: z.number().min(0).default(2),
  })
  .strict();
export type MatcherConfig = z.infer<typeof configSchema>;

const ID = 'matcher-default';

export default defineMatcherPlugin<MatcherConfig>({
  manifest: {
    id: ID,
    version: '0.1.0',
    stage: 'matcher',
    description: 'Hard filters, then embedding-similarity prefilter, then a batched LLM rubric with reasons.',
    configSchema,
    permissions: { domains: [], llm: true },
    sideEffects: 'none',
  },

  async score(ctx, jobs, profile) {
    return scoreJobs(ctx, jobs, profile);
  },
});

export async function scoreJobs(ctx: PluginContext<MatcherConfig>, jobs: Job[], profile: Profile): Promise<MatchResult[]> {
  const cfg = ctx.config;
  const out: MatchResult[] = [];
  const base = { provider: null, model: null, confidence: null } as const;

  // 1. Hard filters
  const passed: Job[] = [];
  for (const job of jobs) {
    const reason = applyHardFilters(job, profile.preferences, cfg);
    if (reason) out.push({ ...base, jobId: job.id, method: 'filtered', score: 0, similarity: null, rubric: { stage: 'hard_filter' }, reasons: reason });
    else passed.push(job);
  }

  // 2. Embedding prefilter
  if (!profile.embedding) throw new Error('profile has no embedding; run the embed step first');
  const ranked: { job: Job; sim: number }[] = [];
  let unembedded = 0;
  for (const job of passed) {
    if (!job.embedding) {
      unembedded++; // no result: picked up again once embedded
      continue;
    }
    ranked.push({ job, sim: dot(job.embedding, profile.embedding) });
  }
  ranked.sort((a, b) => b.sim - a.sim);

  const toLlm: { job: Job; sim: number }[] = [];
  ranked.forEach((r, i) => {
    if (r.sim < cfg.minSimilarity) {
      out.push({
        ...base,
        jobId: r.job.id,
        method: 'prefilter',
        score: 0,
        similarity: r.sim,
        rubric: { stage: 'prefilter' },
        reasons: `Low similarity to your profile (${r.sim.toFixed(2)} < ${cfg.minSimilarity})`,
      });
    } else if (toLlm.length >= cfg.llmTopK) {
      out.push({
        ...base,
        jobId: r.job.id,
        method: 'prefilter',
        score: 0,
        similarity: r.sim,
        rubric: { stage: 'prefilter', rank: i + 1 },
        reasons: `Similarity ${r.sim.toFixed(2)} ranked #${i + 1}, outside this run's top ${cfg.llmTopK} sent to the LLM`,
      });
    } else {
      toLlm.push(r);
    }
  });
  ctx.log.info(
    { jobs: jobs.length, filtered: jobs.length - passed.length, unembedded, prefiltered: ranked.length - toLlm.length, llm: toLlm.length },
    'matcher stages',
  );
  if (!toLlm.length) return out;

  // 3. Batched LLM rubric
  const llm = ctx.llm;
  if (!llm) throw new Error(`${ID} needs an LLM client (permissions.llm)`);
  const batches: { ref: string; job: Job; sim: number }[][] = [];
  for (let i = 0; i < toLlm.length; i += cfg.batchSize) {
    batches.push(toLlm.slice(i, i + cfg.batchSize).map((r, j) => ({ ...r, ref: `J${j + 1}` })));
  }
  let failedBatches = 0;
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await llm.generate({
          task: 'match',
          system: SYSTEM_PROMPT,
          prompt: batchPrompt(profile, batch, cfg.descriptionChars),
          schema: rubricResponseSchema,
          maxTokens: 400 * batch.length + 200,
          signal: ctx.signal,
        });
        const byRef = new Map<string, RubricItem>();
        for (const r of res.data.results) if (!byRef.has(r.ref)) byRef.set(r.ref, r);
        for (const b of batch) {
          const r = byRef.get(b.ref);
          if (!r) continue; // missing from the answer: retried next run
          out.push({
            jobId: b.job.id,
            method: 'llm',
            score: r.score,
            similarity: b.sim,
            rubric: {
              stack_fit: r.stack_fit,
              seniority_fit: r.seniority_fit,
              location_fit: r.location_fit,
              eligibility: r.eligibility,
              concerns: r.concerns,
            },
            reasons: r.reasons,
            provider: res.provider,
            model: res.model,
            confidence: r.confidence,
          });
        }
        const missing = batch.filter((b) => !byRef.has(b.ref)).length;
        if (missing) ctx.log.warn({ missing }, 'LLM omitted some jobs from a batch');
      } catch (err) {
        failedBatches++;
        ctx.log.warn({ err: err instanceof Error ? err.message : String(err), jobs: batch.length }, 'LLM batch failed');
      }
    }),
  );
  if (failedBatches === batches.length) throw new Error(`all ${batches.length} LLM batches failed; see logs`);
  return out;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
