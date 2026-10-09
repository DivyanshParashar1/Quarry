import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@jobforge/shared';
import { assembleTex } from './assembler.js';
import { loadResume } from './manifest-loader.js';
import { compileLatex } from './compile.js';
import { deterministicSelection, selectedBullets } from './index.js';
import {
  DEFAULT_FIT,
  applyTypography,
  extractBullets,
  fitPreamble,
  fitToOnePage,
  plainText,
  typographySteps,
  type BulletRef,
  type Shortener,
} from './fit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(HERE, '../../../profile/resume/manifest.yaml');
const log = createLogger({ level: 'silent' });

/**
 * Fake latexmk: page count from a crude area model. Text area scales with
 * font² (glyph width × line height) × linespread; `capacity` is one page.
 */
function fakeCompiler(capacity: number) {
  const calls: string[] = [];
  const compile = async (tex: string) => {
    calls.push(tex);
    const m = tex.match(/% jobforge fit: ([\d.]+)pt, linespread ([\d.]+)/);
    const font = m ? Number(m[1]) : 10;
    const spread = m ? Number(m[2]) : 1;
    const area = textArea(tex) * (font / 10) ** 2 * spread;
    return { pdf: new Uint8Array([37, 80, 68, 70]), pages: Math.ceil(area / capacity) };
  };
  return { compile, calls };
}

function textArea(tex: string): number {
  return extractBullets('x', tex).reduce((n, b) => n + plainText(b.text).length, 0);
}

async function fixture() {
  const resume = await loadResume(MANIFEST);
  const ids = deterministicSelection(resume).included_block_ids;
  const tex = assembleTex({ resume, includedBlockIds: ids });
  return { tex, bullets: selectedBullets(resume, ids), area: textArea(tex) };
}

/** Drops the last ~45% of words, keeping LaTeX balanced by working on plain text. */
const honestShortener: Shortener = async ({ bullets }) =>
  bullets.map((b) => {
    const words = plainText(b.text).split(' ');
    return { id: b.id, text: words.slice(0, Math.ceil(words.length * 0.55)).join(' ').replace(/%/g, '\\%') };
  });

describe('fit preamble', () => {
  it('is empty at the base size and spacing', () => {
    expect(fitPreamble({ fontPt: 10, linespread: 1 })).toBe('');
  });

  it('rescales every size command proportionally', () => {
    const p = fitPreamble({ fontPt: 9, linespread: 0.94 });
    expect(p).toContain('\\renewcommand\\normalsize{\\@setfontsize\\normalsize{9}{10.8}}');
    expect(p).toContain('\\renewcommand\\small{\\@setfontsize\\small{8.1}{9.9}}');
    expect(p).toContain('\\renewcommand\\Huge{\\@setfontsize\\Huge{22.39}{27}}');
    expect(p).toContain('\\linespread{0.94}');
  });

  it('goes into a %%FIT%% slot when present, else before \\begin{document}', () => {
    const t = { fontPt: 9.5, linespread: 1 };
    const slotted = applyTypography('\\documentclass[10pt]{article}\n%%FIT%%\nX\n\\begin{document}\n\\end{document}', t);
    expect(slotted.indexOf('jobforge fit')).toBeLessThan(slotted.indexOf('X'));
    const plain = applyTypography('\\documentclass[10pt]{article}\nX\n\\begin{document}\n\\end{document}', t);
    expect(plain.indexOf('jobforge fit')).toBeGreaterThan(plain.indexOf('X'));
    expect(plain.indexOf('jobforge fit')).toBeLessThan(plain.indexOf('\\begin{document}'));
  });

  it('steps font to the floor, then line spacing', () => {
    expect(typographySteps(10, DEFAULT_FIT)).toEqual([
      { fontPt: 9.5, linespread: 1 },
      { fontPt: 9, linespread: 1 },
      { fontPt: 9, linespread: 0.97 },
      { fontPt: 9, linespread: 0.94 },
    ]);
  });
});

describe('extractBullets', () => {
  it('brace-matches bodies and uses declared ids by position', () => {
    const frag = '\\resumeItem{A \\textbf{b} c}\n\\resumeItem{D $<$1}\n\\resumeItem{E}';
    expect(extractBullets('blk', frag, ['blk.one', 'blk.two'])).toEqual([
      { id: 'blk.one', text: 'A \\textbf{b} c' },
      { id: 'blk.two', text: 'D $<$1' },
      { id: 'blk.b3', text: 'E' },
    ]);
  });

  it('finds every bullet of the real resume with manifest ids', async () => {
    const { bullets } = await fixture();
    expect(bullets.map((b) => b.id)).toContain('proj.crdt.b2');
    expect(bullets.find((b) => b.id === 'proj.crdt.b2')!.text).toMatch(/^Built a bidirectional/);
  });
});

describe('fitToOnePage', () => {
  it('leaves a one-page resume alone', async () => {
    const { tex, bullets, area } = await fixture();
    const fake = fakeCompiler(area * 1.1);
    const r = await fitToOnePage(tex, bullets, DEFAULT_FIT, { compile: fake.compile, log });
    expect(r.overflow).toBe(false);
    expect(r.fit).toMatchObject({ fontPt: 10, linespread: 1, rounds: 0, compiles: 1 });
    expect(r.tex).toBe(tex);
  });

  it('brings a 2-page assembly to 1 page by typography alone', async () => {
    const { tex, bullets, area } = await fixture();
    // 10pt and 9.5pt overflow (area 1.0, 0.9025); 9pt fits (0.81).
    const fake = fakeCompiler(area * 0.85);
    let shortenCalls = 0;
    const r = await fitToOnePage(tex, bullets, DEFAULT_FIT, {
      compile: fake.compile,
      shorten: async (req) => {
        shortenCalls++;
        return honestShortener(req);
      },
      log,
    });
    expect(r.overflow).toBe(false);
    expect(r.pages).toBe(1);
    expect(r.fit).toMatchObject({ fontPt: 9, linespread: 1, rounds: 0, compiles: 3, shortenedBullets: [] });
    expect(shortenCalls).toBe(0);
    expect(r.tex).toContain('% jobforge fit: 9pt, linespread 1');
  });

  it('shortens bullets when typography runs out, and reverts one that invents a number', async () => {
    const { tex, bullets, area } = await fixture();
    // 9pt × 0.94 = 0.761 of the area — still over; shortening must close the gap.
    const fake = fakeCompiler(area * 0.72);
    const seen: BulletRef[][] = [];
    const shorten: Shortener = async (req) => {
      seen.push(req.bullets);
      const out = await honestShortener(req);
      // The longest bullet's rewrite slips in a metric the original never had.
      out[0] = { id: out[0]!.id, text: `Cut latency by 73% across ${plainText(req.bullets[0]!.text).split(' ').slice(0, 4).join(' ')}` };
      return out;
    };
    const r = await fitToOnePage(tex, bullets, DEFAULT_FIT, { compile: fake.compile, shorten, log });

    expect(r.overflow).toBe(false);
    expect(r.pages).toBe(1);
    expect(r.fit.fontPt).toBe(9);
    expect(r.fit.linespread).toBe(0.94);
    expect(r.fit.rounds).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toHaveLength(DEFAULT_FIT.shortenBullets);

    const invented = r.report.find((v) => v.issues.some((i) => i.kind === 'invented_number'));
    expect(invented).toBeDefined();
    expect(invented!.reverted).toBe(true);
    expect(r.fit.shortenedBullets).not.toContain(invented!.bullet_id);
    // The original text of the reverted bullet is still in the final .tex.
    expect(r.tex).toContain(`\\resumeItem{${invented!.original}}`);
    expect(r.tex).not.toContain('73%');
    expect(r.fit.shortenedBullets.length).toBeGreaterThan(0);
  });

  it('reports overflow when nothing fits', async () => {
    const { tex, bullets, area } = await fixture();
    const fake = fakeCompiler(area * 0.3);
    const r = await fitToOnePage(tex, bullets, DEFAULT_FIT, { compile: fake.compile, shorten: honestShortener, log });
    expect(r.overflow).toBe(true);
    expect(r.pages).toBeGreaterThan(1);
    expect(r.fit.rounds).toBe(DEFAULT_FIT.maxShortenRounds);
  });

  it('without a shortener, overflows after typography', async () => {
    const { tex, bullets, area } = await fixture();
    const fake = fakeCompiler(area * 0.72);
    const r = await fitToOnePage(tex, bullets, DEFAULT_FIT, { compile: fake.compile, log });
    expect(r.overflow).toBe(true);
    expect(r.fit).toMatchObject({ fontPt: 9, linespread: 0.94, rounds: 0, compiles: 5 });
  });

  it('reverts a whole shortening round whose .tex fails to compile', async () => {
    const { tex, bullets, area } = await fixture();
    const fake = fakeCompiler(area * 0.72);
    const compile = async (src: string) => {
      if (fake.calls.length >= 5) throw new Error('Undefined control sequence');
      return fake.compile(src);
    };
    const r = await fitToOnePage(tex, bullets, DEFAULT_FIT, { compile, shorten: honestShortener, log });
    expect(r.overflow).toBe(true);
    expect(r.fit.shortenedBullets).toEqual([]);
    expect(r.report.every((v) => v.reverted)).toBe(true);
    expect(r.tex).not.toContain('\\resumeItem{' + plainText(bullets[0]!.text).split(' ').slice(0, 3).join(' ') + '}');
  });
});

function hasLatexmk(): boolean {
  try {
    execFileSync(process.env.LATEX_BIN ?? 'latexmk', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('fitToOnePage with real latexmk', () => {
  // Self-contained (no fullpage/fontawesome) so it runs on a minimal TeX install.
  it.skipIf(!hasLatexmk())('shrinks a 2-page document to 1 page with the injected font sizes', async () => {
    const item = 'Implemented a text editing engine from scratch using a replicated growable array with logical clocks and tombstone deletion so replicas converge.';
    const bullets = Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, text: `${i} ${item}` }));
    const tex = [
      '\\documentclass[letterpaper,10pt]{article}',
      '\\newcommand{\\resumeItem}[1]{\\item\\small{#1}}',
      '\\begin{document}',
      '{\\Huge Name}',
      '\\begin{itemize}',
      ...bullets.map((b) => `\\resumeItem{${b.text}}`),
      '\\end{itemize}',
      '\\end{document}',
      '',
    ].join('\n');
    const signal = AbortSignal.timeout(120_000);
    const r = await fitToOnePage(tex, bullets, DEFAULT_FIT, { compile: (src) => compileLatex({ tex: src, log, signal }), log });
    expect(r.overflow).toBe(false);
    expect(r.pages).toBe(1);
    expect(r.fit).toMatchObject({ fontPt: 9, linespread: 1, compiles: 3 });
    expect(r.tex).toContain('\\RequirePackage{fix-cm}');
    expect(r.pdf.byteLength).toBeGreaterThan(1000);
  }, 120_000);
});
