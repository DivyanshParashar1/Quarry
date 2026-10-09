import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ResumeComboSpec } from '@jobforge/plugin-sdk';
import type { LoadedResume } from './manifest-loader.js';

// Phase 16 resume library. Every subset of exactly N project blocks (always_include
// projects are in every subset) is one combo; every other block is in all of them.
// Base resumes are fixed selections from profile/resume/base/*.yaml.

export function comboKey(ids: string[]): string {
  return [...ids].sort().join('+');
}

export function listProjectCombos(resume: LoadedResume, projectsPerResume: number): ResumeComboSpec[] {
  const { manifest, blocksById } = resume;
  const projects = manifest.blocks.filter((b) => b.section === 'projects');
  const always = projects.filter((b) => b.always_include);
  const optional = projects.filter((b) => !b.always_include);
  const others = manifest.blocks.filter((b) => b.section !== 'projects').map((b) => b.id);
  const want = Math.max(always.length, Math.min(projectsPerResume, projects.length));

  const out: ResumeComboSpec[] = [];
  for (const pick of subsets(optional.map((b) => b.id), want - always.length)) {
    const projectIds = projects.map((b) => b.id).filter((id) => always.some((a) => a.id === id) || pick.includes(id));
    const ids = orderBySections(resume, [...others, ...projectIds]);
    out.push({
      key: comboKey(ids),
      label: projectIds.map((id) => blocksById.get(id)!.title ?? id).join(' + ') || 'No projects',
      kind: 'combo',
      includedBlockIds: ids,
      skills: 'projects',
    });
  }
  return out;
}

/** All k-element subsets, in input order. */
export function subsets<T>(items: T[], k: number): T[][] {
  if (k <= 0) return [[]];
  if (k > items.length) return [];
  const out: T[][] = [];
  const rec = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < items.length; i++) rec(i + 1, [...acc, items[i]!]);
  };
  rec(0, []);
  return out;
}

const baseFileSchema = z
  .object({
    label: z.string().min(1).optional(),
    /** Block ids; the header block is always added. */
    blocks: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** profile/resume/base/*.yaml → base resume specs. Unknown block ids are an error. */
export async function listBaseResumes(resume: LoadedResume): Promise<ResumeComboSpec[]> {
  const dir = join(resume.rootDir, 'base');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return [];
  }
  const out: ResumeComboSpec[] = [];
  for (const f of files) {
    const parsed = baseFileSchema.parse(parseYaml(await readFile(join(dir, f), 'utf8')));
    const unknown = parsed.blocks.filter((id) => !resume.blocksById.has(id));
    if (unknown.length) throw new Error(`base resume ${f}: unknown block id(s) ${unknown.join(', ')}`);
    const ids = orderBySections(resume, [resume.manifest.header_block, ...parsed.blocks]);
    out.push({
      key: comboKey(ids),
      label: parsed.label ?? `Base: ${basename(f).replace(/\.ya?ml$/, '')}`,
      kind: 'base',
      includedBlockIds: ids,
      skills: 'none',
    });
  }
  return out;
}

/** Header first, then sections in manifest order, blocks in manifest order; duplicates dropped. */
export function orderBySections(resume: LoadedResume, ids: string[]): string[] {
  const set = new Set(ids);
  const { manifest } = resume;
  const out = [manifest.header_block];
  for (const section of manifest.sections_order) {
    for (const b of manifest.blocks) if (b.section === section && set.has(b.id)) out.push(b.id);
  }
  return out;
}
