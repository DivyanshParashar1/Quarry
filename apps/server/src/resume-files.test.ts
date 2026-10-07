import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertBlockId,
  deleteBlock,
  readResume,
  reorderBlocks,
  upsertBlock,
  ResumeFileError,
} from './resume-files.js';

const MANIFEST = `# resume
sections_order: [projects]
sections:
  projects:
    header: "\\\\section{Projects}"
    inner_start: "\\\\start"
    inner_end: "\\\\end"
    separator: ""
header_block: header
blocks:
  - id: header
    file: blocks/header.tex
    section: header
    always_include: true
  - id: proj.a
    file: blocks/proj.a.tex
    section: projects
    title: Alpha
`;

describe('resume-files writers', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jf-resume-'));
    mkdirSync(join(dir, 'blocks'));
    writeFileSync(join(dir, 'manifest.yaml'), MANIFEST);
    writeFileSync(join(dir, 'blocks/header.tex'), '% header\n');
    writeFileSync(join(dir, 'blocks/proj.a.tex'), '% alpha\n');
  });
  afterEach(() => {
    // intentionally leave temp dirs around — tmpdir cleans up
  });

  it('reads the manifest + fragments', () => {
    const r = readResume(dir);
    expect(r.manifest.sections_order).toEqual(['projects']);
    expect(r.fragments['proj.a']).toContain('alpha');
  });

  it('creates a new block (writes fragment + inserts into manifest)', () => {
    const r = upsertBlock(dir, {
      id: 'proj.b',
      section: 'projects',
      title: 'Beta',
      tags: ['go'],
      latex: '% beta\n',
    });
    expect(r.created).toBe(true);
    expect(existsSync(join(dir, 'blocks/proj.b.tex'))).toBe(true);
    const yaml = readFileSync(join(dir, 'manifest.yaml'), 'utf8');
    expect(yaml).toContain('proj.b');
    expect(readResume(dir).manifest.blocks.find((b) => b.id === 'proj.b')?.title).toBe('Beta');
  });

  it('updates an existing block in place', () => {
    const r = upsertBlock(dir, {
      id: 'proj.a',
      section: 'projects',
      title: 'Alpha v2',
      latex: '% alpha v2\n',
    });
    expect(r.created).toBe(false);
    expect(readFileSync(join(dir, 'blocks/proj.a.tex'), 'utf8')).toContain('alpha v2');
    expect(readResume(dir).manifest.blocks.find((b) => b.id === 'proj.a')?.title).toBe('Alpha v2');
  });

  it('rejects invalid ids', () => {
    expect(() => assertBlockId('../etc/passwd')).toThrow(ResumeFileError);
    expect(() => assertBlockId('UPPER')).toThrow(ResumeFileError);
    expect(() => assertBlockId('')).toThrow(ResumeFileError);
    expect(() => assertBlockId('ok.id')).not.toThrow();
  });

  it('deletes a block and removes its fragment file', () => {
    const r = deleteBlock(dir, 'proj.a');
    expect(r.deleted).toBe(true);
    expect(existsSync(join(dir, 'blocks/proj.a.tex'))).toBe(false);
    expect(readResume(dir).manifest.blocks.map((b) => b.id)).not.toContain('proj.a');
  });

  it('reorders blocks within a section', () => {
    upsertBlock(dir, { id: 'proj.b', section: 'projects', title: 'B', latex: '% b\n' });
    upsertBlock(dir, { id: 'proj.c', section: 'projects', title: 'C', latex: '% c\n' });
    reorderBlocks(dir, 'projects', ['proj.c', 'proj.a']);
    const ids = readResume(dir).manifest.blocks.filter((b) => b.section === 'projects').map((b) => b.id);
    expect(ids).toEqual(['proj.c', 'proj.a', 'proj.b']);
  });

  it('refuses writes under an unknown section', () => {
    expect(() => upsertBlock(dir, { id: 'x', section: 'nope', latex: 'y' })).toThrow(ResumeFileError);
  });
});
