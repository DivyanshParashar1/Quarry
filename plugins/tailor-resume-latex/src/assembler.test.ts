import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleTex, applySkillsReorder } from './assembler.js';
import { loadResume } from './manifest-loader.js';
import { deterministicSelection } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(HERE, '../../../profile/resume/manifest.yaml');
const ORIGINAL = resolve(HERE, '../../../my_resume.tex');

describe('assembler', () => {
  // my_resume.tex is the user's private original (gitignored); skip on a clean clone.
  it.skipIf(!existsSync(ORIGINAL))('deterministic selection reproduces my_resume.tex modulo whitespace', async () => {
    const resume = await loadResume(MANIFEST);
    const sel = deterministicSelection(resume);
    const tex = assembleTex({ resume, includedBlockIds: sel.included_block_ids });

    const original = await readFile(ORIGINAL, 'utf8');
    // Strip comments + collapse whitespace: LaTeX is whitespace-insensitive at
    // this level, so parity should hold once both are normalised.
    expect(normalise(tex)).toBe(normalise(original));
  });

  it('applies a bullet rewrite by exact-string replace against the fragment', async () => {
    const resume = await loadResume(MANIFEST);
    const flashseat = resume.manifest.blocks.find((b) => b.id === 'proj.flashseat')!;
    const originalFragment = resume.fragments.get(flashseat.id)!;
    // Pick the first bullet's text verbatim out of the fragment.
    const match = originalFragment.match(/\\resumeItem\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/);
    expect(match).toBeTruthy();
    const originalBullet = match![0]!; // includes the \resumeItem{...} wrapper
    const rewrittenBullet = originalBullet.replace('seat-booking', 'ticket-booking');

    const sel = deterministicSelection(resume);
    const tex = assembleTex({
      resume,
      includedBlockIds: sel.included_block_ids,
      bulletRewrites: [
        { bullet_id: 'proj.flashseat.b1', original: originalBullet, rewritten: rewrittenBullet, reason: 't' },
      ],
    });
    expect(tex).toContain(rewrittenBullet);
    expect(tex).not.toContain(originalBullet);
  });

  it('reorders a skills group and preserves dropped items at the tail', () => {
    const fragment = `\\textbf{Languages}{: JavaScript, TypeScript, Python, Java, SQL}`;
    const out = applySkillsReorder(fragment, [{ group: 'Languages', ordered: ['Python', 'TypeScript'] }]);
    expect(out).toBe(`\\textbf{Languages}{: Python, TypeScript, JavaScript, Java, SQL}`);
  });
});

function normalise(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/%.*$/, '').trim()) // drop line comments, trim leading/trailing ws
    .filter(Boolean)
    .join('\n');
}
