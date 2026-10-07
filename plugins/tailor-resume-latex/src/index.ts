import { resolve } from 'node:path';
import { z } from 'zod';
import {
  defineTailorPlugin,
  type Job,
  type PluginContext,
  type Profile,
  type TailoredResume,
  type TailorSelection,
} from '@jobforge/plugin-sdk';
import { loadResume, type LoadedResume } from './manifest-loader.js';
import { assembleTex } from './assembler.js';
import { compileLatex } from './compile.js';
import { selectBlocks } from './selector.js';
import { tailorSkills, type SkillsResult } from './skills.js';

export * from './manifest-loader.js';
export * from './assembler.js';
export * from './compile.js';
export {
  selectBlocks,
  selectionOutputSchema,
  enforceRules,
  type SelectDeps,
  type SelectResult,
} from './selector.js';
export {
  tailorSkills,
  skillsOutputSchema,
  validateSkillsLatex,
  extractItemCatalogue,
  type SkillsResult,
  type ValidationOk,
  type ValidationErr,
} from './skills.js';

export const configSchema = z
  .object({
    /** Absolute or cwd-relative path to profile/resume/manifest.yaml. */
    manifestPath: z.string().default('profile/resume/manifest.yaml'),
    latexBin: z.string().optional(),
    /**
     * deterministic = include every manifest block in declared order (no LLM).
     * llm           = ask the LLM to pick blocks + regenerate the skills section.
     */
    mode: z.enum(['deterministic', 'llm']).default('llm'),
    /** When mode=llm, also regenerate the skills fragment via LLM. */
    tailorSkills: z.boolean().default(true),
  })
  .strict();
export type TailorConfig = z.infer<typeof configSchema>;

export const PLUGIN_ID = 'tailor-resume-latex';

export default defineTailorPlugin<TailorConfig>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.3.0',
    stage: 'tailor',
    description:
      'Block-based resume tailoring: LLM picks fragments from profile/resume/, optionally regenerates the Technical Skills section, then compiles via latexmk.',
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
  _profile: Profile,
): Promise<TailoredResume> {
  const manifestPath = resolve(ctx.config.manifestPath);
  const resume = await loadResume(manifestPath);

  let selection: TailorSelection;
  let provider = 'deterministic';
  let model = 'none';

  if (ctx.config.mode === 'llm') {
    if (!ctx.llm) throw new Error(`${PLUGIN_ID} mode=llm needs an LLM client (permissions.llm)`);
    const r = await selectBlocks(resume, job, { llm: ctx.llm, signal: ctx.signal });
    selection = {
      included_block_ids: r.included_block_ids,
      bullet_rewrites: r.bullet_rewrites,
      tech_stack_rewrites: r.tech_stack_rewrites,
      skills_reorder: r.skills_reorder,
      rationale: r.rationale,
      confidence: r.confidence,
    };
    provider = r.provider;
    model = r.model;
  } else {
    selection = deterministicSelection(resume);
  }

  let skills: SkillsResult | null = null;
  const fragmentOverrides: Record<string, string> = {};
  if (ctx.config.mode === 'llm' && ctx.config.tailorSkills && ctx.llm) {
    try {
      skills = await tailorSkills(resume, job, { llm: ctx.llm, signal: ctx.signal });
      if (skills && skills.used) {
        const skillsBlock = resume.manifest.blocks.find((b) => b.section === 'skills');
        if (skillsBlock) fragmentOverrides[skillsBlock.id] = skills.latex;
      } else if (skills && !skills.used) {
        ctx.log.warn({ reason: skills.reason }, 'tailor: skills rewrite rejected; falling back to original');
      }
    } catch (err) {
      ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'tailor: skills rewrite failed; using original');
    }
  }

  const tex = assembleTex({
    resume,
    includedBlockIds: selection.included_block_ids,
    bulletRewrites: selection.bullet_rewrites,
    techStackRewrites: selection.tech_stack_rewrites,
    skillsReorder: selection.skills_reorder,
    fragmentOverrides,
  });

  try {
    const { pdf, pages } = await compileLatex({
      tex,
      ...(ctx.config.latexBin ? { latexBin: ctx.config.latexBin } : {}),
      log: ctx.log,
      signal: ctx.signal,
    });
    return {
      tex,
      pdf,
      pages,
      selection,
      report: [],
      status: 'rendered',
      error: null,
      confidence: selection.confidence,
      provider: skills?.used ? `${provider}+skills` : provider,
      model,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.warn({ error: message }, 'tailor: latexmk compile failed; returning tex-only variant');
    return {
      tex,
      pdf: null,
      pages: null,
      selection,
      report: [],
      status: 'render_failed',
      error: message,
      confidence: 0,
      provider,
      model,
    };
  }
}

/** Deterministic fallback: pick every block in manifest order (used by mode='deterministic'). */
export function deterministicSelection(resume: LoadedResume): TailorSelection {
  const ids: string[] = [resume.manifest.header_block];
  for (const section of resume.manifest.sections_order) {
    for (const b of resume.manifest.blocks) {
      if (b.section === section) ids.push(b.id);
    }
  }
  return {
    included_block_ids: ids,
    bullet_rewrites: [],
    tech_stack_rewrites: [],
    skills_reorder: [],
    rationale: 'deterministic: all blocks in manifest order',
    confidence: 1,
  };
}
