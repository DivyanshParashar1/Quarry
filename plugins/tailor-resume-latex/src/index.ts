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
import { DEFAULT_FIT, extractBullets, fitToOnePage, type BulletRef } from './fit.js';
import { llmShortener } from './shorten.js';

export * from './manifest-loader.js';
export * from './assembler.js';
export * from './compile.js';
export * from './fit.js';
export * from './shorten.js';
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
  techStackItems,
  type SkillsInput,
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
    /** One-page fit loop (Phase 15): font → line spacing → LLM bullet shortening. */
    fit: z
      .object({
        enabled: z.boolean().default(DEFAULT_FIT.enabled),
        minFontPt: z.number().min(6).max(12).default(DEFAULT_FIT.minFontPt),
        fontStepPt: z.number().positive().max(2).default(DEFAULT_FIT.fontStepPt),
        minLinespread: z.number().min(0.8).max(1).default(DEFAULT_FIT.minLinespread),
        linespreadStep: z.number().positive().max(0.1).default(DEFAULT_FIT.linespreadStep),
        maxShortenRounds: z.number().int().min(0).max(5).default(DEFAULT_FIT.maxShortenRounds),
        shortenBullets: z.number().int().min(1).max(20).default(DEFAULT_FIT.shortenBullets),
      })
      .strict()
      .default({}),
  })
  .strict();
export type TailorConfig = z.infer<typeof configSchema>;

export const PLUGIN_ID = 'tailor-resume-latex';

export default defineTailorPlugin<TailorConfig>({
  manifest: {
    id: PLUGIN_ID,
    version: '0.4.0',
    stage: 'tailor',
    description:
      'Block-based resume tailoring: LLM picks fragments from profile/resume/, optionally regenerates the Technical Skills section, compiles via latexmk and fits the result to one page.',
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

  const assemble = (fragmentOverrides: Record<string, string> = {}) =>
    assembleTex({
      resume,
      includedBlockIds: selection.included_block_ids,
      bulletRewrites: selection.bullet_rewrites,
      techStackRewrites: selection.tech_stack_rewrites,
      skillsReorder: selection.skills_reorder,
      fragmentOverrides,
    });

  let tex = assemble();
  let skills: SkillsResult | null = null;
  if (ctx.config.mode === 'llm' && ctx.config.tailorSkills && ctx.llm) {
    try {
      skills = await tailorSkills(
        resume,
        job,
        { assembledTex: tex, includedBlockIds: selection.included_block_ids },
        { llm: ctx.llm, signal: ctx.signal },
      );
      if (skills && skills.used) {
        const skillsBlock = resume.manifest.blocks.find((b) => b.section === 'skills');
        if (skillsBlock) tex = assemble({ [skillsBlock.id]: skills.latex });
      } else if (skills && !skills.used) {
        ctx.log.warn({ reason: skills.reason }, 'tailor: skills rewrite rejected; falling back to original');
      }
    } catch (err) {
      ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'tailor: skills rewrite failed; using original');
    }
  }
  const providerLabel = skills?.used ? `${provider}+skills` : provider;

  try {
    const compile = (src: string) =>
      compileLatex({
        tex: src,
        ...(ctx.config.latexBin ? { latexBin: ctx.config.latexBin } : {}),
        log: ctx.log,
        signal: ctx.signal,
      });
    const fitted = await fitToOnePage(tex, selectedBullets(resume, selection.included_block_ids), ctx.config.fit, {
      compile,
      ...(ctx.config.mode === 'llm' && ctx.llm ? { shorten: llmShortener(ctx.llm, ctx.signal) } : {}),
      log: ctx.log,
    });
    if (fitted.overflow) {
      ctx.log.warn({ pages: fitted.pages, fit: fitted.fit }, 'tailor: still over one page after every fit step');
    }
    return {
      tex: fitted.tex,
      pdf: fitted.pdf,
      pages: fitted.pages,
      selection,
      report: fitted.report,
      status: fitted.overflow ? 'overflow' : 'rendered',
      error: fitted.overflow ? `resume is ${fitted.pages} pages after every fit step` : null,
      confidence: selection.confidence,
      provider: fitted.fit.rounds > 0 ? `${providerLabel}+shorten` : providerLabel,
      model,
      fit: fitted.fit,
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
      fit: null,
    };
  }
}

/** `\resumeItem` bullets of the selected blocks (skills and header have none worth shortening). */
export function selectedBullets(resume: LoadedResume, includedBlockIds: string[]): BulletRef[] {
  const out: BulletRef[] = [];
  for (const id of includedBlockIds) {
    const block = resume.blocksById.get(id);
    if (!block || block.section === 'skills' || block.section === 'header') continue;
    const fragment = resume.fragments.get(id);
    if (!fragment) continue;
    out.push(...extractBullets(id, fragment, block.bullets.map((b) => b.id)));
  }
  return out;
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
