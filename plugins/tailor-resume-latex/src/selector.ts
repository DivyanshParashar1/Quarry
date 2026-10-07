import { z } from 'zod';
import type { Job, LLMClient } from '@jobforge/plugin-sdk';
import type { BlockMeta, Budget, TailorSelection } from '@jobforge/plugin-sdk';
import type { LoadedResume } from './manifest-loader.js';

// LLM-driven block selection. The LLM returns ordered block ids per section
// plus a rationale; the code enforces hard rules (always_include blocks, min
// counts, max counts) so a bad LLM response never produces an invalid resume.

export const SYSTEM_PROMPT = `You pick which pre-written resume blocks to include for a specific job.
You never write LaTeX or edit bullets. Your only output is a list of block ids
(in priority order per section) with a short rationale.

Rules:
- Pick blocks whose tags best match the job's role, stack, and seniority.
- Respect every section's min/max budget. Return ids in priority order inside
  each section (first = most important for this job); lower-ranked blocks are
  the first to be dropped if the page overflows.
- You may include fewer blocks than the maximum when the catalogue is too
  narrow. Do NOT include a block that is wrong for the job just to hit a count.
- Blocks the user marked "always include" are included automatically by the
  caller; you can omit them from your output.
- Do not invent block ids. Only pick from the catalogue below.`;

export const selectionOutputSchema = z.object({
  included_block_ids: z.array(z.string().min(1)).min(1),
  rationale: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.5),
});

export interface SelectDeps {
  llm: LLMClient;
  signal: AbortSignal;
  maxTokens?: number;
}

export interface SelectResult extends TailorSelection {
  provider: string;
  model: string;
}

export async function selectBlocks(
  resume: LoadedResume,
  job: Job,
  deps: SelectDeps,
): Promise<SelectResult> {
  const prompt = buildPrompt(resume, job);
  const res = await deps.llm.generate({
    task: 'tailor',
    system: SYSTEM_PROMPT,
    prompt,
    schema: selectionOutputSchema,
    maxTokens: deps.maxTokens ?? 800,
    signal: deps.signal,
  });

  const enforced = enforceRules(resume, res.data.included_block_ids);
  return {
    included_block_ids: enforced,
    bullet_rewrites: [],
    tech_stack_rewrites: [],
    skills_reorder: [],
    rationale: res.data.rationale ?? '',
    confidence: res.data.confidence ?? 0.5,
    provider: res.provider,
    model: res.model,
  };
}

export function buildPrompt(resume: LoadedResume, job: Job): string {
  const catalogue = resume.manifest.blocks
    .filter((b) => b.section !== 'header')
    .map((b) => {
      const parts = [
        `- id: ${b.id}`,
        `  section: ${b.section}`,
        b.title ? `  title: ${b.title}` : null,
        b.always_include ? `  always_include: true` : null,
        b.tags.length ? `  tags: [${b.tags.join(', ')}]` : null,
      ].filter(Boolean);
      return parts.join('\n');
    })
    .join('\n');

  const budget = formatBudget(resume.manifest.budget);
  const sections = resume.manifest.sections_order.filter((s) => s !== 'header').join(', ');
  const desc = (job.descriptionMd ?? '').slice(0, 4000);

  return [
    `# Target job`,
    ``,
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    job.seniority ? `Seniority: ${job.seniority}` : null,
    job.locations.length ? `Locations: ${job.locations.join(', ')}` : null,
    job.remotePolicy ? `Remote policy: ${job.remotePolicy}` : null,
    ``,
    `## Description`,
    desc || '(no description)',
    ``,
    `# Catalogue`,
    `Sections (in display order): ${sections}`,
    budget,
    ``,
    catalogue,
    ``,
    `Return JSON of { included_block_ids: [...], rationale, confidence } where`,
    `included_block_ids is a priority-ordered list across all sections.`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function formatBudget(b: Budget): string {
  const lines: string[] = ['Budget:'];
  if (b.experience_blocks) lines.push(`  experience blocks: ${b.experience_blocks.min}..${b.experience_blocks.max}`);
  if (b.project_blocks) lines.push(`  project blocks: ${b.project_blocks.min}..${b.project_blocks.max}`);
  if (b.total_bullets_hint) lines.push(`  rough bullet budget: ~${b.total_bullets_hint}`);
  return lines.length > 1 ? lines.join('\n') : 'Budget: (none)';
}

/**
 * Clamp the LLM's picks to the catalogue + budget. The resulting list keeps
 * the LLM's priority order inside each section and places sections in the
 * manifest's `sections_order`. always_include blocks are prepended per
 * section if the LLM omitted them.
 */
export function enforceRules(resume: LoadedResume, llmPicks: string[]): string[] {
  const byId = resume.blocksById;
  const bySection = new Map<string, BlockMeta[]>();
  for (const b of resume.manifest.blocks) {
    if (b.section === 'header') continue;
    const list = bySection.get(b.section) ?? [];
    list.push(b);
    bySection.set(b.section, list);
  }

  // Normalize picks: drop unknowns + header + duplicates, keep order.
  const seen = new Set<string>();
  const normalisedPicks: BlockMeta[] = [];
  for (const id of llmPicks) {
    if (seen.has(id)) continue;
    const b = byId.get(id);
    if (!b || b.section === 'header') continue;
    seen.add(id);
    normalisedPicks.push(b);
  }

  const perSectionBudget = sectionBudget(resume.manifest.budget);
  const out: string[] = [resume.manifest.header_block];

  for (const section of resume.manifest.sections_order) {
    if (section === 'header') continue;
    const allInSection = bySection.get(section) ?? [];
    const alwaysIds = allInSection.filter((b) => b.always_include).map((b) => b.id);
    const limits = perSectionBudget.get(section);
    const max = limits?.max ?? Number.POSITIVE_INFINITY;
    const min = limits?.min ?? 0;

    // Start with always_include, then LLM picks (that aren't already added),
    // then — if below min — fill from manifest order.
    const picked: string[] = [...alwaysIds];
    for (const b of normalisedPicks) {
      if (b.section !== section) continue;
      if (picked.includes(b.id)) continue;
      if (picked.length >= max) break;
      picked.push(b.id);
    }
    if (picked.length < min) {
      for (const b of allInSection) {
        if (picked.includes(b.id)) continue;
        picked.push(b.id);
        if (picked.length >= min) break;
      }
    }
    out.push(...picked.slice(0, max));
  }
  return out;
}

function sectionBudget(b: Budget): Map<string, { min: number; max: number }> {
  const m = new Map<string, { min: number; max: number }>();
  if (b.experience_blocks) m.set('experience', b.experience_blocks);
  if (b.project_blocks) m.set('projects', b.project_blocks);
  return m;
}
