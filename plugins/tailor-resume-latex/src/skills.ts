import { z } from 'zod';
import type { Job, LLMClient } from '@jobforge/plugin-sdk';
import type { LoadedResume } from './manifest-loader.js';

// Technical Skills tailoring:
//   - The LLM receives the original skills fragment + the JD and emits a new
//     LaTeX fragment tailored to the role (reorder/trim groups and items).
//   - The output is validated by a strict allowlist of LaTeX commands before
//     being used; on any violation we fall back to the original fragment.
//   - The LLM must not add skills the user never listed — we extract the
//     catalogue of items from the original fragment and enforce it after
//     parsing the LLM's output.

export const SYSTEM_PROMPT = `You tailor a LaTeX "Technical Skills" fragment for a specific job.
You MUST return ONLY the LaTeX fragment, nothing else — no markdown, no fences, no commentary.

Rules:
- Keep the exact outer structure: \\begin{itemize}[leftmargin=0.15in, label={}] ... \\end{itemize}
  with one \\small{\\item{ ... }} wrapper, and group lines in the form:
  \\textbf{<Group>}{: item, item, item} \\\\
- You may reorder groups so the most JD-relevant group is listed first.
- You may reorder items inside a group to lead with JD-relevant ones.
- You may DROP items that are irrelevant to the job.
- You MAY NOT add items that aren't in the original. If a JD mentions a skill
  the user doesn't have, do not fabricate it.
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

export async function tailorSkills(
  resume: LoadedResume,
  job: Job,
  deps: { llm: LLMClient; signal: AbortSignal; maxTokens?: number },
): Promise<SkillsResult | null> {
  const skillsBlock = resume.manifest.blocks.find((b) => b.section === 'skills');
  if (!skillsBlock) return null;
  const original = resume.fragments.get(skillsBlock.id);
  if (!original) return null;

  const catalogue = extractItemCatalogue(original);
  const res = await deps.llm.generate({
    task: 'tailor',
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(original, job),
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

export function buildPrompt(original: string, job: Job): string {
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
    `# Original "Technical Skills" fragment (verbatim):`,
    original.trim(),
    ``,
    `Return JSON of { latex: "<the tailored fragment>" }.`,
  ]
    .filter((l) => l !== null)
    .join('\n');
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
