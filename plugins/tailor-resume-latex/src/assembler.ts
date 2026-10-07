import type { BulletRewrite, TechStackRewrite, SkillsReorder } from '@jobforge/plugin-sdk';
import type { LoadedResume } from './manifest-loader.js';

export interface AssembleInput {
  resume: LoadedResume;
  /** Ordered list of block ids to include; header block is always prepended. */
  includedBlockIds: string[];
  bulletRewrites?: BulletRewrite[];
  techStackRewrites?: TechStackRewrite[];
  skillsReorder?: SkillsReorder[];
  /** Replace a block's fragment wholesale (used for the LLM-regenerated skills). */
  fragmentOverrides?: Record<string, string>;
}

/**
 * Build the final .tex string by:
 *   1. applying any bullet/tech-stack rewrites to the fragment contents
 *      (string replace; the guardrail is applied upstream — this is dumb);
 *   2. grouping fragments by `section` and wrapping each section per
 *      `manifest.sections[section]`;
 *   3. emitting sections in `manifest.sections_order` with the header block on top.
 */
export function assembleTex(input: AssembleInput): string {
  const { resume, includedBlockIds } = input;
  const { manifest, preamble, fragments, blocksById } = resume;

  const rewritesByBullet = new Map((input.bulletRewrites ?? []).map((r) => [r.bullet_id, r]));
  const techByBlock = new Map((input.techStackRewrites ?? []).map((r) => [r.block_id, r]));

  // ---- apply rewrites per-fragment -------------------------------------------------
  const rewrittenFragments = new Map<string, string>();
  for (const [id, text] of fragments) {
    const overridden = input.fragmentOverrides?.[id];
    let out = overridden ?? text;
    const block = blocksById.get(id)!;
    // Overrides replace the whole fragment; bullet/tech rewrites don't apply.
    if (overridden) {
      rewrittenFragments.set(id, out);
      continue;
    }

    // Bullet rewrites: for each bullet declared on this block, find its original
    // text (if present in the rewrite set) and replace with the rewritten form.
    for (const b of block.bullets) {
      const rw = rewritesByBullet.get(b.id);
      if (!rw) continue;
      if (!out.includes(rw.original)) {
        throw new Error(`bullet rewrite for ${b.id}: original text not found in ${block.file}`);
      }
      out = out.replace(rw.original, rw.rewritten);
    }

    // Tech-stack rewrite: a project's \emph{...} line.
    const ts = techByBlock.get(id);
    if (ts) {
      if (!out.includes(ts.original)) {
        throw new Error(`tech_stack rewrite for ${id}: original text not found in ${block.file}`);
      }
      out = out.replace(ts.original, ts.rewritten);
    }

    rewrittenFragments.set(id, out);
  }

  // Skills section reorder: operate on the skills fragment's groups.
  const skillsBlockId = manifest.blocks.find((b) => b.section === 'skills')?.id;
  if (skillsBlockId && input.skillsReorder?.length) {
    rewrittenFragments.set(
      skillsBlockId,
      applySkillsReorder(rewrittenFragments.get(skillsBlockId)!, input.skillsReorder),
    );
  }

  // ---- group selected blocks by section --------------------------------------------
  const bySection = new Map<string, string[]>();
  for (const id of includedBlockIds) {
    const block = blocksById.get(id);
    if (!block) throw new Error(`included_block_ids references unknown block "${id}"`);
    if (block.section === 'header') continue;
    const list = bySection.get(block.section) ?? [];
    list.push(id);
    bySection.set(block.section, list);
  }

  // ---- emit sections in order ------------------------------------------------------
  const headerBlockId = manifest.header_block;
  // The header is always rendered, whether or not the selection lists it.
  const headerTex = rewrittenFragments.get(headerBlockId)!.trimEnd();

  const sectionChunks: string[] = [];
  for (const section of manifest.sections_order) {
    const blockIds = bySection.get(section);
    if (!blockIds?.length) continue;
    const wrapper = manifest.sections[section]!;
    const inner = blockIds
      .map((id) => rewrittenFragments.get(id)!.trimEnd())
      .join(wrapper.separator ? `\n${wrapper.separator}\n\n` : '\n\n');
    const parts = [wrapper.header];
    if (wrapper.inner_start) parts.push(wrapper.inner_start);
    parts.push(inner);
    if (wrapper.inner_end) parts.push(wrapper.inner_end);
    sectionChunks.push(parts.join('\n'));
  }

  return [
    preamble.trimEnd(),
    '',
    '\\begin{document}',
    '',
    headerTex,
    '',
    sectionChunks.join('\n\n\n'),
    '',
    '\\end{document}',
    '',
  ].join('\n');
}

/**
 * Replace the ordering of items inside a group line of the skills fragment.
 * Group lines look like: `\textbf{Languages}{: JavaScript, TypeScript, ...}`.
 * We rebuild the comma-separated list using `reorder.ordered`, keeping any
 * items the LLM dropped at the end so skills are never silently lost.
 */
export function applySkillsReorder(fragment: string, reorders: SkillsReorder[]): string {
  let out = fragment;
  for (const r of reorders) {
    const pattern = new RegExp(`(\\\\textbf\\{${escapeRegex(r.group)}\\}\\{:\\s*)([^}]*)(\\})`);
    const m = out.match(pattern);
    if (!m) continue;
    const original = m[2]!.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const s of r.ordered) {
      const match = original.find((o) => o.toLowerCase() === s.toLowerCase());
      if (match && !seen.has(match)) {
        ordered.push(match);
        seen.add(match);
      }
    }
    for (const o of original) if (!seen.has(o)) ordered.push(o);
    out = out.replace(pattern, `$1${ordered.join(', ')}$3`);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
