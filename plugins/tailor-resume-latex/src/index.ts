import { z } from 'zod';
import {
  defineTailorPlugin,
  tailoredResumeSchema,
  type FactValidation,
  type Job,
  type PluginContext,
  type Profile,
  type TailoredResume,
  type ValidationIssue,
} from '@jobforge/plugin-sdk';
import { outputSchema, SYSTEM_PROMPT, tailorPrompt } from './prompt.js';
import { validate } from './validator.js';

export * from './prompt.js';
export * from './validator.js';

export const configSchema = z
  .object({
    /** Hard cap on bullets the LLM may return (and the resume page can fit). */
    maxBullets: z.number().int().min(3).max(20).default(10),
    /** Soft cap on characters per bullet; longer bullets are flagged (not dropped). */
    bulletMaxChars: z.number().int().min(80).max(400).default(220),
  })
  .strict();
export type TailorConfig = z.infer<typeof configSchema>;

export const PLUGIN_ID = 'tailor-resume-latex';

/** Result of the tailor stage: validated resume plus the full validation report. */
export interface TailorOutcome extends TailoredResume {
  report: FactValidation[];
  dropped: FactValidation[];
  headerIssues: ValidationIssue[];
  /** Self-reported 0..1 confidence; the autopilot gates on this. */
  confidence: number;
  provider: string;
  model: string;
}

export default defineTailorPlugin<TailorConfig>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.1.0',
    stage: 'tailor',
    description: 'LLM selects + rephrases profile facts for a job; validator drops any bullet that invents experience.',
    configSchema,
    permissions: { domains: [], llm: true },
    sideEffects: 'none',
  },

  async tailor(ctx, job, profile) {
    return tailorOne(ctx, job, profile);
  },
});

export async function tailorOne(
  ctx: PluginContext<TailorConfig>,
  job: Job,
  profile: Profile,
): Promise<TailorOutcome> {
  if (!profile.facts.length) throw new Error('profile has no facts; fill in profile/facts.yaml and run `jf profile load`');
  const llm = ctx.llm;
  if (!llm) throw new Error(`${PLUGIN_ID} needs an LLM client (permissions.llm)`);

  const res = await llm.generate({
    task: 'tailor',
    system: SYSTEM_PROMPT,
    prompt: tailorPrompt(job, profile, ctx.config.maxBullets),
    schema: outputSchema,
    maxTokens: 2000,
    signal: ctx.signal,
  });

  const trimmed = { ...res.data, bullets: res.data.bullets.slice(0, ctx.config.maxBullets) };
  const parsed = tailoredResumeSchema.parse(trimmed);
  const v = validate({
    bullets: parsed.bullets,
    header: parsed.header,
    facts: profile.facts,
    bulletMaxChars: ctx.config.bulletMaxChars,
    allowedSkills: profile.preferences.stack,
  });

  if (!v.bullets.length) {
    ctx.log.warn({ dropped: v.dropped.length }, 'tailor: all bullets failed validation');
  } else if (v.dropped.length) {
    ctx.log.info({ kept: v.bullets.length, dropped: v.dropped.length }, 'tailor: some bullets dropped by validator');
  }

  // Downgrade confidence if the validator had to drop or warn on bullets.
  const dropped = v.dropped.length;
  const warned = v.report.filter((r) => r.status === 'warning').length;
  const headerPenalty = v.headerIssues.length * 0.05;
  const dropPenalty = Math.min(0.5, dropped * 0.1);
  const warnPenalty = Math.min(0.2, warned * 0.03);
  const confidence = Math.max(0, Math.min(1, res.data.confidence - dropPenalty - warnPenalty - headerPenalty));

  return {
    bullets: v.bullets,
    header: v.header,
    report: v.report,
    dropped: v.dropped,
    headerIssues: v.headerIssues,
    confidence,
    provider: res.provider,
    model: res.model,
  };
}
