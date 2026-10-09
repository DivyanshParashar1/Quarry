import { z } from 'zod';
import type { Job, LLMClient } from '@jobforge/plugin-sdk';
import type { LoadedResume } from './manifest-loader.js';

// Technical Skills tailoring (v2, Phase 15):
//   - The LLM receives the JD + the full assembled resume .tex (so it can see
//     the selected projects' tech-stack lines) and emits only a new skills
//     LaTeX fragment (reorder/trim groups and items).
//   - Allowed items = the original skills fragment's items ∪ the tech-stack
//     items of the selected blocks, so a skill used in a project can surface
//     even when the skills block missed it. Anything else is rejected.
//   - The output is validated by a strict allowlist of LaTeX commands before
//     being used; on any violation we fall back to the original fragment.

export const SYSTEM_PROMPT = `You tailor a LaTeX "Technical Skills" fragment for a specific job.
You MUST return ONLY the LaTeX fragment, nothing else — no markdown, no fences, no commentary.

Rules:
- Keep the exact outer structure: \\begin{itemize}[leftmargin=0.15in, label={}] ... \\end{itemize}
  with one \\small{\\item{ ... }} wrapper, and group lines in the form:
  \\textbf{<Group>}{: item, item, item} \\\\
- You may reorder groups so the most JD-relevant group is listed first.
- You may reorder items inside a group to lead with JD-relevant ones.
- You may DROP items that are irrelevant to the job.
- You may ADD an item only if it is in the "Allowed items" list (they come from
  the resume's own project tech stacks). Put it in the group where it fits.
- You MAY NOT add anything else. If a JD mentions a skill the user doesn't have,
  do not fabricate it.
- You MAY NOT introduce new LaTeX commands beyond: \\begin, \\end, \\small, \\item, \\textbf, \\textit, \\\\.
- Do not use \\input, \\include, \\write, \\usepackage, \\def, \\let, \\catcode, or any @ commands.`;

export const skillsOutputSchema = z.object({
  latex: z.string().min(1).max(4000),
});

export interface SkillsResult {
  latex: string;
  used: boolean;
  reason: string;
  provider: string;
  model: string;
}

export interface SkillsInput {
  /** The resume assembled with the original skills fragment. */
  assembledTex: string;
  /** Selected block ids; their tech-stack items join the allowed catalogue. */
  includedBlockIds: string[];
}

export async function tailorSkills(
  resume: LoadedResume,
  job: Job,
  input: SkillsInput,
  deps: { llm: LLMClient; signal: AbortSignal; maxTokens?: number },
): Promise<SkillsResult | null> {
  const skillsBlock = resume.manifest.blocks.find((b) => b.section === 'skills');
  if (!skillsBlock) return null;
  const original = resume.fragments.get(skillsBlock.id);
  if (!original) return null;

  const catalogue = extractItemCatalogue(original);
  const extra = techStackItems(resume, input.includedBlockIds).filter((i) => !hasCaseInsensitive(catalogue, i));
  for (const i of extra) catalogue.add(i);

  const res = await deps.llm.generate({
    task: 'tailor',
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(original, job, input.assembledTex, extra),
    schema: skillsOutputSchema,
    maxTokens: deps.maxTokens ?? 600,
    signal: deps.signal,
  });

  const check = validateSkillsLatex(res.data.latex, catalogue);
  if (!check.ok) {
    return {
      latex: original,
      used: false,
      reason: `rejected: ${check.reason}`,
      provider: res.provider,
      model: res.model,
    };
  }
  return { latex: check.latex, used: true, reason: 'ok', provider: res.provider, model: res.model };
}

export function buildPrompt(original: string, job: Job, assembledTex: string, allowedExtra: string[]): string {
  const desc = (job.descriptionMd ?? '').slice(0, 4000);
  return [
    `# Target job`,
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    job.seniority ? `Seniority: ${job.seniority}` : null,
    ``,
    `## Description`,
    desc || '(no description)',
    ``,
    `# The full resume as it will be sent (LaTeX):`,
    resumeBody(assembledTex),
    ``,
    `# Original "Technical Skills" fragment (verbatim):`,
    original.trim(),
    ``,
    `# Allowed items not in the fragment (from the selected projects' tech stacks):`,
    allowedExtra.length ? allowedExtra.join(', ') : '(none)',
    ``,
    `Return JSON of { latex: "<the tailored fragment>" }.`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** The resume between \begin{document} and \end{document} (the preamble is noise to the LLM). */
function resumeBody(tex: string): string {
  const start = tex.indexOf('\\begin{document}');
  const end = tex.lastIndexOf('\\end{document}');
  const body = start >= 0 && end > start ? tex.slice(start + '\\begin{document}'.length, end) : tex;
  return body.trim().slice(0, 12_000);
}

/**
 * Tech-stack items of the selected blocks: the manifest's `tech_stack_line`,
 * else the block's `\emph{...}` line. Items are comma-separated.
 */
export function techStackItems(resume: LoadedResume, includedBlockIds: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of includedBlockIds) {
    const block = resume.blocksById.get(id);
    if (!block || block.section === 'skills' || block.section === 'header') continue;
    const line = block.tech_stack_line ?? resume.fragments.get(id)?.match(/\\emph\{([^}]*)\}/)?.[1];
    if (!line) continue;
    for (const raw of line.split(/,\s*/)) {
      const item = raw.trim();
      if (item && !seen.has(item.toLowerCase())) {
        seen.add(item.toLowerCase());
        out.push(item);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const ALLOWED_COMMANDS = new Set([
  'begin',
  'end',
  'small',
  'item',
  'textbf',
  'textit',
  '\\',
]);

const FORBIDDEN_SUBSTRINGS = [
  '\\input',
  '\\include',
  '\\write',
  '\\usepackage',
  '\\def',
  '\\let',
  '\\catcode',
  '\\expandafter',
  '\\immediate',
  '\\openout',
  '\\loop',
  '\\csname',
  '\\endcsname',
  '\\@',
  '\\verb',
  '\\url',
  '\\href',
  '%!TEX',
];

export interface ValidationOk {
  ok: true;
  latex: string;
}
export interface ValidationErr {
  ok: false;
  reason: string;
}

/**
 * Reject the LLM output unless:
 *   (1) only commands from the allowlist appear;
 *   (2) none of the forbidden substrings appear;
 *   (3) every item mentioned appears in the original catalogue (case-insensitive);
 *   (4) the fragment opens with \begin{itemize}... and closes with \end{itemize}.
 */
export function validateSkillsLatex(latex: string, catalogue: Set<string>): ValidationOk | ValidationErr {
  const trimmed = latex.trim();
  if (!trimmed.includes('\\begin{itemize}')) return { ok: false, reason: 'missing \\begin{itemize}' };
  if (!trimmed.endsWith('\\end{itemize}')) return { ok: false, reason: 'does not end with \\end{itemize}' };

  for (const bad of FORBIDDEN_SUBSTRINGS) {
    if (trimmed.includes(bad)) return { ok: false, reason: `forbidden token: ${bad}` };
  }

  const commands = new Set<string>();
  for (const m of trimmed.matchAll(/\\([a-zA-Z@]+|\\)/g)) commands.add(m[1]!);
  for (const c of commands) {
    if (!ALLOWED_COMMANDS.has(c)) return { ok: false, reason: `disallowed command: \\${c}` };
  }

  // Items must come from the original catalogue.
  const used = extractItemCatalogue(trimmed);
  const unknown: string[] = [];
  for (const u of used) {
    if (!hasCaseInsensitive(catalogue, u)) unknown.push(u);
  }
  if (unknown.length) return { ok: false, reason: `invented items: ${unknown.slice(0, 5).join(', ')}` };

  return { ok: true, latex: trimmed };
}

/** Pull every comma-separated item out of every `\textbf{Group}{: a, b, c}` line. */
export function extractItemCatalogue(fragment: string): Set<string> {
  const items = new Set<string>();
  for (const m of fragment.matchAll(/\\textbf\{[^}]+\}\{:\s*([^}]*)\}/g)) {
    for (const raw of m[1]!.split(/,\s*/)) {
      const s = raw.trim();
      if (s) items.add(s);
    }
  }
  return items;
}

function hasCaseInsensitive(set: Set<string>, needle: string): boolean {
  const lower = needle.toLowerCase();
  for (const s of set) if (s.toLowerCase() === lower) return true;
  return false;
}
