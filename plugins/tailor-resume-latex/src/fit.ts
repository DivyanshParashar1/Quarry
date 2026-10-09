import type { FitInfo, RewriteValidation } from '@jobforge/plugin-sdk';
import type { Logger } from '@jobforge/shared';
import type { CompileResult } from './compile.js';
import { validateShortening } from './shorten.js';

// One-page fit loop (Phase 15). Deterministic except for step 4:
//   1. compile; 1 page → done.
//   2. step the whole document's font size down (10pt → 9.5pt → 9pt).
//   3. step \linespread down (1.0 → 0.97 → 0.94).
//   4. ask the LLM to shorten the longest bullets; each rewrite goes through
//      the guardrail and is reverted if it adds a number/term/command.
//   5. still > 1 page → overflow (the caller keeps the variant but never auto-uses it).
//
// The typography is injected into the assembled .tex (at a `%%FIT%%` line if
// the preamble has one, otherwise just before \begin{document}), so
// profile/resume/preamble.tex is never edited.

export interface FitConfig {
  enabled: boolean;
  minFontPt: number;
  fontStepPt: number;
  minLinespread: number;
  linespreadStep: number;
  maxShortenRounds: number;
  shortenBullets: number;
}

export const DEFAULT_FIT: FitConfig = {
  enabled: true,
  minFontPt: 9,
  fontStepPt: 0.5,
  minLinespread: 0.94,
  linespreadStep: 0.03,
  maxShortenRounds: 2,
  shortenBullets: 4,
};

export interface Typography {
  fontPt: number;
  linespread: number;
}

/** A bullet in the assembled .tex: `\resumeItem{<text>}`. */
export interface BulletRef {
  id: string;
  text: string;
}

export interface ShortenRequest {
  bullets: BulletRef[];
}
export type Shortener = (req: ShortenRequest) => Promise<BulletRef[]>;

export interface FitDeps {
  compile: (tex: string) => Promise<CompileResult>;
  /** Absent → no shortening (deterministic mode, or no LLM). */
  shorten?: Shortener;
  log: Logger;
}

export interface FitOutcome {
  tex: string;
  pdf: Uint8Array;
  pages: number;
  overflow: boolean;
  fit: FitInfo;
  report: RewriteValidation[];
}

export const FIT_SLOT = '%%FIT%%';

// article's size10.clo: [size, baselineskip] per size command.
const SIZE10: Array<[string, number, number]> = [
  ['tiny', 5, 6],
  ['scriptsize', 7, 8],
  ['footnotesize', 8, 9.5],
  ['small', 9, 11],
  ['normalsize', 10, 12],
  ['large', 12, 14],
  ['Large', 14.4, 18],
  ['LARGE', 17.28, 22],
  ['huge', 20.74, 25],
  ['Huge', 24.88, 30],
];

/** The class's base size from `\documentclass[...,10pt]{...}`; 10 when absent. */
export function baseFontPt(tex: string): number {
  const m = tex.match(/\\documentclass\[([^\]]*)\]/);
  const opt = m?.[1]?.split(',').map((s) => s.trim()).find((s) => /^\d+(\.\d+)?pt$/.test(s));
  return opt ? Number.parseFloat(opt) : 10;
}

/**
 * LaTeX that rescales every size command proportionally (so the name,
 * section headings and \small bullets all shrink together) and sets
 * \linespread. Empty when nothing changes.
 */
export function fitPreamble(t: Typography, basePt = 10): string {
  const lines: string[] = [];
  if (t.fontPt !== basePt) {
    const f = t.fontPt / 10;
    lines.push('\\makeatletter');
    for (const [name, size, skip] of SIZE10) {
      lines.push(`\\renewcommand\\${name}{\\@setfontsize\\${name}{${fmt(size * f)}}{${fmt(skip * f)}}}`);
    }
    lines.push('\\makeatother', '\\AtBeginDocument{\\normalsize}');
  }
  if (t.linespread !== 1) lines.push(`\\linespread{${fmt(t.linespread)}}`);
  if (!lines.length) return '';
  return [`% jobforge fit: ${t.fontPt}pt, linespread ${t.linespread}`, ...lines].join('\n');
}

export function applyTypography(tex: string, t: Typography): string {
  const basePt = baseFontPt(tex);
  const block = fitPreamble(t, basePt);
  let out = tex;
  // Computer Modern only has fixed design sizes above 12pt; fix-cm makes the
  // scaled \Huge/\LARGE sizes exact instead of snapping to the nearest one.
  if (t.fontPt !== basePt && !/fix-cm|type1cm/.test(out)) {
    const cls = out.indexOf('\\documentclass');
    if (cls >= 0) out = `${out.slice(0, cls)}\\RequirePackage{fix-cm}\n${out.slice(cls)}`;
  }
  if (out.includes(FIT_SLOT)) return out.replace(FIT_SLOT, block);
  if (!block) return out;
  const at = out.indexOf('\\begin{document}');
  if (at < 0) throw new Error('fit: no \\begin{document} in the assembled .tex');
  return `${out.slice(0, at)}${block}\n\n${out.slice(at)}`;
}

/** Typography steps after the base: font sizes first, then line spacing at the smallest font. */
export function typographySteps(basePt: number, cfg: FitConfig): Typography[] {
  const steps: Typography[] = [];
  let font = basePt;
  while (round2(font - cfg.fontStepPt) >= cfg.minFontPt - 1e-9) {
    font = round2(font - cfg.fontStepPt);
    steps.push({ fontPt: font, linespread: 1 });
  }
  let spread = 1;
  while (round2(spread - cfg.linespreadStep) >= cfg.minLinespread - 1e-9) {
    spread = round2(spread - cfg.linespreadStep);
    steps.push({ fontPt: font, linespread: spread });
  }
  return steps;
}

export async function fitToOnePage(
  assembled: string,
  bullets: BulletRef[],
  cfg: FitConfig,
  deps: FitDeps,
): Promise<FitOutcome> {
  const basePt = baseFontPt(assembled);
  let typo: Typography = { fontPt: basePt, linespread: 1 };
  let tex = assembled;
  let compiles = 0;
  const compile = async (src: string) => {
    compiles++;
    return deps.compile(applyTypography(src, typo));
  };

  let out = await compile(tex);
  const finish = (overflow: boolean, rounds: number, shortened: string[], report: RewriteValidation[]): FitOutcome => ({
    tex: applyTypography(tex, typo),
    pdf: out.pdf,
    pages: out.pages,
    overflow,
    report,
    fit: { fontPt: typo.fontPt, linespread: typo.linespread, shortenedBullets: shortened, rounds, compiles, pages: out.pages },
  });
  if (out.pages <= 1 || !cfg.enabled) return finish(out.pages > 1, 0, [], []);

  for (const step of typographySteps(basePt, cfg)) {
    typo = step;
    out = await compile(tex);
    deps.log.debug({ ...typo, pages: out.pages }, 'fit: typography step');
    if (out.pages <= 1) return finish(false, 0, [], []);
  }

  const report: RewriteValidation[] = [];
  const shortened = new Set<string>();
  const current = new Map(bullets.map((b) => [b.id, b.text]));
  let rounds = 0;
  if (deps.shorten) {
    while (rounds < cfg.maxShortenRounds) {
      rounds++;
      const picks = longestBullets([...current].map(([id, text]) => ({ id, text })), cfg.shortenBullets);
      if (!picks.length) break;
      let proposals: BulletRef[];
      try {
        proposals = await deps.shorten({ bullets: picks });
      } catch (err) {
        deps.log.warn({ err: (err as Error).message }, 'fit: shortening call failed');
        break;
      }
      const byId = new Map(proposals.map((p) => [p.id, p.text]));
      let next = tex;
      const accepted: Array<[string, string]> = [];
      const roundReports: RewriteValidation[] = [];
      for (const pick of picks) {
        const rewritten = byId.get(pick.id);
        if (rewritten === undefined) continue;
        const v = validateShortening(pick.id, pick.text, rewritten);
        roundReports.push(v);
        if (v.reverted) continue;
        const needle = `\\resumeItem{${pick.text}}`;
        if (!next.includes(needle)) {
          v.status = 'error';
          v.reverted = true;
          v.issues.push({ kind: 'unknown_bullet_id', detail: 'bullet text not found in the assembled .tex' });
          continue;
        }
        next = next.replace(needle, `\\resumeItem{${v.rewritten}}`);
        accepted.push([pick.id, v.rewritten]);
      }
      if (!accepted.length) {
        report.push(...roundReports);
        continue;
      }
      let attempt: CompileResult;
      try {
        attempt = await compile(next);
      } catch (err) {
        // A shortening that breaks compilation is reverted as a whole round.
        for (const r of roundReports) {
          if (r.reverted) continue;
          r.status = 'error';
          r.reverted = true;
          r.issues.push({ kind: 'invented_term', detail: `compile failed: ${(err as Error).message.slice(0, 200)}` });
        }
        report.push(...roundReports);
        break;
      }
      report.push(...roundReports);
      tex = next;
      out = attempt;
      for (const [id, text] of accepted) {
        current.set(id, text);
        shortened.add(id);
      }
      deps.log.debug({ round: rounds, accepted: accepted.length, pages: out.pages }, 'fit: shortening round');
      if (out.pages <= 1) return finish(false, rounds, [...shortened], report);
    }
  }
  return finish(out.pages > 1, rounds, [...shortened], report);
}

/** The `n` bullets with the longest visible text. */
export function longestBullets(bullets: BulletRef[], n: number): BulletRef[] {
  return [...bullets].sort((a, b) => plainText(b.text).length - plainText(a.text).length).slice(0, n);
}

/** Visible text of a LaTeX snippet (commands dropped, arguments kept). */
export function plainText(latex: string): string {
  return latex
    .replace(/\\([%$&#_{}])/g, '$1')
    .replace(/\\[a-zA-Z]+\*?/g, '')
    .replace(/[{}$]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every `\resumeItem{...}` body in a fragment, brace-matched. Ids come from the
 * manifest's declared bullets (by position) or `<blockId>.b<n>`.
 */
export function extractBullets(blockId: string, fragment: string, declaredIds: string[] = []): BulletRef[] {
  const out: BulletRef[] = [];
  const open = '\\resumeItem{';
  let from = 0;
  for (;;) {
    const at = fragment.indexOf(open, from);
    if (at < 0) break;
    let depth = 1;
    let i = at + open.length;
    for (; i < fragment.length && depth > 0; i++) {
      const c = fragment[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth !== 0) break;
    const n = out.length;
    out.push({ id: declaredIds[n] ?? `${blockId}.b${n + 1}`, text: fragment.slice(at + open.length, i - 1) });
    from = i;
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}
