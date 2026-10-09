import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { comboKey, listBaseResumes, listProjectCombos, subsets } from './combos.js';
import { loadResume } from './manifest-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESUME_DIR = resolve(HERE, '../../../profile/resume');

describe('subsets', () => {
  it('lists k-subsets in input order', () => {
    expect(subsets(['a', 'b', 'c', 'd'], 3)).toEqual([
      ['a', 'b', 'c'],
      ['a', 'b', 'd'],
      ['a', 'c', 'd'],
      ['b', 'c', 'd'],
    ]);
    expect(subsets(['a'], 0)).toEqual([[]]);
    expect(subsets(['a'], 2)).toEqual([]);
  });
});

describe('listProjectCombos (real manifest: 3 projects)', () => {
  it('N=2 gives every pair, each with all non-project blocks', async () => {
    const resume = await loadResume(join(RESUME_DIR, 'manifest.yaml'));
    const combos = listProjectCombos(resume, 2);
    expect(combos.map((c) => c.label)).toEqual(['FlashSeat + CRDT Collaborative Editor', 'FlashSeat + DrillMirror', 'CRDT Collaborative Editor + DrillMirror']);
    for (const c of combos) {
      expect(c.includedBlockIds[0]).toBe('header');
      expect(c.includedBlockIds).toEqual(expect.arrayContaining(['edu.rgipt', 'exp.screenify', 'exp.orangecat', 'skills.default', 'extra.tpc']));
      expect(c.includedBlockIds.filter((id) => id.startsWith('proj.'))).toHaveLength(2);
      expect(c.key).toBe(comboKey(c.includedBlockIds));
      expect(c).toMatchObject({ kind: 'combo', skills: 'projects' });
    }
    // Section order: projects come after experience, skills after projects.
    const ids = combos[0]!.includedBlockIds;
    expect(ids.indexOf('exp.orangecat')).toBeLessThan(ids.indexOf('proj.flashseat'));
    expect(ids.indexOf('proj.crdt')).toBeLessThan(ids.indexOf('skills.default'));
  });

  it('N=3 (default) gives the one 3-project combo; N above the count clamps', async () => {
    const resume = await loadResume(join(RESUME_DIR, 'manifest.yaml'));
    expect(listProjectCombos(resume, 3)).toHaveLength(1);
    expect(listProjectCombos(resume, 9)).toHaveLength(1);
  });

  it('always_include projects are in every combo', async () => {
    const resume = await loadResume(join(RESUME_DIR, 'manifest.yaml'));
    resume.blocksById.get('proj.crdt')!.always_include = true;
    const combos = listProjectCombos(resume, 2);
    expect(combos).toHaveLength(2);
    for (const c of combos) expect(c.includedBlockIds).toContain('proj.crdt');
  });
});

describe('listBaseResumes', () => {
  it('reads profile/resume/base/default.yaml', async () => {
    const resume = await loadResume(join(RESUME_DIR, 'manifest.yaml'));
    const bases = await listBaseResumes(resume);
    expect(bases).toHaveLength(1);
    expect(bases[0]).toMatchObject({ kind: 'base', skills: 'none', label: 'Base: all blocks' });
    expect(bases[0]!.includedBlockIds[0]).toBe('header');
    expect(bases[0]!.includedBlockIds).toHaveLength(9);
  });

  it('rejects unknown block ids and tolerates a missing base dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jf-resume-'));
    await cp(RESUME_DIR, dir, { recursive: true });
    await mkdir(join(dir, 'base'), { recursive: true });
    await writeFile(join(dir, 'base', 'bad.yaml'), 'blocks: [proj.nope]\n');
    const resume = await loadResume(join(dir, 'manifest.yaml'));
    await expect(listBaseResumes(resume)).rejects.toThrow(/unknown block id\(s\) proj.nope/);

    const empty = await mkdtemp(join(tmpdir(), 'jf-resume-'));
    await cp(RESUME_DIR, empty, { recursive: true, filter: (src) => !src.includes(`${RESUME_DIR}/base`) });
    expect(await listBaseResumes(await loadResume(join(empty, 'manifest.yaml')))).toEqual([]);
  });
});
