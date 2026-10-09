import { keywordCoverage, type Dictionary, type JdKeywords } from './keywords.js';
import type { ParseCheck, ParseReport } from './parse-checks.js';
import { ATS_PROFILES, PROFILES, type AtsProfileType } from './profiles.js';

export * from './keywords.js';
export * from './lexicon.js';
export * from './parse-checks.js';
export * from './pdf-text.js';
export * from './profiles.js';

// Deterministic ATS score (Phase 16): parse checks on the extracted PDF text,
// keyword coverage against the JD, weighted per ATS. No LLM.

export interface AtsScore {
  /** 0–100 */
  score: number;
  atsType: AtsProfileType;
  parse: { score: number; checks: ParseCheck[] };
  keywords: { coverage: number | null; matched: string[]; missing: string[]; hardMissing: string[] };
  notes: string[];
}

export interface ScoreInput {
  resumeText: string;
  parse: ParseReport;
  /** Null → parse-only score (no JD). */
  jd: JdKeywords | null;
  dictionary: Dictionary;
  atsType: AtsProfileType;
}

export function scoreResume(input: ScoreInput): AtsScore {
  const profile = PROFILES[input.atsType];
  let wSum = 0;
  let acc = 0;
  for (const c of input.parse.checks) {
    const w = profile.checkWeights[c.id];
    wSum += w;
    acc += w * c.score;
  }
  let parseScore = wSum ? acc / wSum : 0;
  // Nothing extractable means nothing else matters.
  const extractable = input.parse.checks.find((c) => c.id === 'extractable');
  if (extractable && extractable.score < 0.5) parseScore = Math.min(parseScore, extractable.score);

  const kw = input.jd ? keywordCoverage(input.resumeText, input.jd, input.dictionary) : { coverage: null, matched: [], missing: [], hardMissing: [] };
  const raw = kw.coverage === null ? parseScore * 100 : profile.parseWeight * parseScore * 100 + (1 - profile.parseWeight) * kw.coverage;
  let score = Math.round(raw);
  if (extractable && extractable.score < 0.5) score = Math.min(score, 10);

  const notes: string[] = [];
  for (const term of kw.hardMissing) notes.push(`Missing hard requirement: ${term}`);
  for (const c of input.parse.checks) {
    if (c.pass) continue;
    notes.push(profile.notes[c.id] ? `${c.detail} (${profile.notes[c.id]})` : c.detail);
  }
  return {
    score,
    atsType: input.atsType,
    parse: { score: Math.round(parseScore * 100), checks: input.parse.checks },
    keywords: kw,
    notes,
  };
}

/** One score per ATS profile — the "tested against every ATS" view. */
export function scoreAllAts(input: Omit<ScoreInput, 'atsType'>): Record<AtsProfileType, AtsScore> {
  const out = {} as Record<AtsProfileType, AtsScore>;
  for (const t of ATS_PROFILES) out[t] = scoreResume({ ...input, atsType: t });
  return out;
}
