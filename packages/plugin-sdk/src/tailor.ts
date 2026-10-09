import { z } from 'zod';

// Block-based tailoring (CLAUDE.md pivot):
//   - The profile exposes a library of LaTeX fragments ("blocks") under
//     profile/resume/blocks/, described by profile/resume/manifest.yaml.
//   - The tailor plugin picks which block ids to include for a given job and,
//     at most, rewrites individual bullets / tech-stack lines to match the JD.
//   - The plugin never writes LaTeX structure. The guardrail only checks that
//     rewrites don't invent numbers or named entities vs the ORIGINAL bullet.

// ---------------------------------------------------------------------------
// Manifest schema — mirrors profile/resume/manifest.yaml
// ---------------------------------------------------------------------------

export const sectionWrapperSchema = z.object({
  header: z.string(),
  inner_start: z.string().default(''),
  inner_end: z.string().default(''),
  separator: z.string().default(''),
});
export type SectionWrapper = z.infer<typeof sectionWrapperSchema>;

export const bulletMetaSchema = z.object({
  id: z.string().min(1),
  tags: z.array(z.string()).default([]),
});
export type BulletMeta = z.infer<typeof bulletMetaSchema>;

export const blockMetaSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  section: z.string().min(1),
  title: z.string().optional(),
  always_include: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  tech_stack_line: z.string().optional(),
  bullets: z.array(bulletMetaSchema).default([]),
});
export type BlockMeta = z.infer<typeof blockMetaSchema>;

export const budgetSchema = z
  .object({
    experience_blocks: z.object({ min: z.number().int().min(0), max: z.number().int().min(1) }).optional(),
    project_blocks: z.object({ min: z.number().int().min(0), max: z.number().int().min(1) }).optional(),
    total_bullets_hint: z.number().int().positive().optional(),
  })
  .default({});
export type Budget = z.infer<typeof budgetSchema>;

export const resumeManifestSchema = z.object({
  sections_order: z.array(z.string()).min(1),
  sections: z.record(z.string(), sectionWrapperSchema),
  header_block: z.string().min(1),
  blocks: z.array(blockMetaSchema).min(1),
  budget: budgetSchema,
});
export type ResumeManifest = z.infer<typeof resumeManifestSchema>;

// ---------------------------------------------------------------------------
// Selection + rewrites — what the LLM (or a deterministic selector) produces
// ---------------------------------------------------------------------------

export const bulletRewriteSchema = z.object({
  bullet_id: z.string().min(1),
  original: z.string().min(1),
  rewritten: z.string().min(1),
  reason: z.string().default(''),
});
export type BulletRewrite = z.infer<typeof bulletRewriteSchema>;

export const techStackRewriteSchema = z.object({
  block_id: z.string().min(1),
  original: z.string().min(1),
  rewritten: z.string().min(1),
});
export type TechStackRewrite = z.infer<typeof techStackRewriteSchema>;

export const skillsReorderSchema = z.object({
  /** Group label, e.g. "Languages" or "Frameworks & Libraries". */
  group: z.string().min(1),
  ordered: z.array(z.string().min(1)).min(1),
});
export type SkillsReorder = z.infer<typeof skillsReorderSchema>;

export const tailorSelectionSchema = z.object({
  /** Ordered by priority; the shrink loop drops from the tail if the PDF overflows. */
  included_block_ids: z.array(z.string().min(1)).min(1),
  bullet_rewrites: z.array(bulletRewriteSchema).default([]),
  tech_stack_rewrites: z.array(techStackRewriteSchema).default([]),
  skills_reorder: z.array(skillsReorderSchema).default([]),
  rationale: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type TailorSelection = z.infer<typeof tailorSelectionSchema>;

// ---------------------------------------------------------------------------
// Guardrail report — flags rewrites that invented content vs the original
// ---------------------------------------------------------------------------

export const guardrailStatusSchema = z.enum(['ok', 'warning', 'error']);
export type GuardrailStatus = z.infer<typeof guardrailStatusSchema>;

export const guardrailIssueSchema = z.object({
  kind: z.enum(['invented_number', 'invented_term', 'too_long', 'empty', 'unknown_bullet_id', 'unknown_block_id']),
  detail: z.string(),
});
export type GuardrailIssue = z.infer<typeof guardrailIssueSchema>;

export const rewriteValidationSchema = z.object({
  bullet_id: z.string(),
  original: z.string(),
  rewritten: z.string(),
  status: guardrailStatusSchema,
  issues: z.array(guardrailIssueSchema),
  /** True when the rewrite was discarded and the original kept. */
  reverted: z.boolean().default(false),
});
export type RewriteValidation = z.infer<typeof rewriteValidationSchema>;

// ---------------------------------------------------------------------------
// Final tailor output. The plugin assembles + compiles; the runner persists.
// ---------------------------------------------------------------------------

/** `overflow` = compiled, but still > 1 page after every fit step; kept, never auto-used. */
export const tailorStatusSchema = z.enum(['rendered', 'render_failed', 'selection_failed', 'overflow']);
export type TailorStatus = z.infer<typeof tailorStatusSchema>;

/** What the one-page fit loop did (Phase 15). Stored on the variant. */
export interface FitInfo {
  fontPt: number;
  linespread: number;
  /** Bullet ids whose shortened text was kept. */
  shortenedBullets: string[];
  /** LLM shortening rounds run (0 when typography alone was enough). */
  rounds: number;
  /** Compiles performed, including the first. */
  compiles: number;
  pages: number;
}

export interface TailoredResume {
  /** The exact .tex sent to latexmk; archived alongside the PDF. */
  tex: string;
  /** PDF bytes when latexmk succeeded, null otherwise. */
  pdf: Uint8Array | null;
  /** Number of pages in the compiled PDF (null when compile failed). */
  pages: number | null;
  selection: TailorSelection;
  /** Per-rewrite guardrail results, including reverts. */
  report: RewriteValidation[];
  status: TailorStatus;
  error: string | null;
  confidence: number;
  provider: string;
  model: string;
  /** Present when the fit loop ran (i.e. the first compile succeeded). */
  fit?: FitInfo | null;
}
