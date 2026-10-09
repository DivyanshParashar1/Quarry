import { TECH_LEXICON, type LexiconEntry } from './lexicon.js';

// Deterministic JD keyword extraction:
//   - dictionary terms = the tech lexicon ∪ the user's own skills;
//   - each hit is weighted by where it appears: a "requirements / must have"
//     section (hard), a "nice to have / preferred" section (soft), elsewhere (normal);
//   - plus the JD's top TF-IDF phrases (against the job corpus) that aren't
//     dictionary terms, at a low weight.

export type KeywordTier = 'hard' | 'normal' | 'soft' | 'phrase';

export const TIER_WEIGHT: Record<KeywordTier, number> = { hard: 3, normal: 2, soft: 1, phrase: 0.5 };

export interface JdKeyword {
  term: string;
  tier: KeywordTier;
}

export interface JdKeywords {
  keywords: JdKeyword[];
}

export interface Dictionary {
  entries: Array<{ term: string; patterns: RegExp[] }>;
}

/** Lexicon ∪ user skills, compiled once. User skills already in the lexicon are not duplicated. */
export function buildDictionary(userSkills: string[] = [], lexicon: LexiconEntry[] = TECH_LEXICON): Dictionary {
  const entries: Dictionary['entries'] = [];
  const seen = new Set<string>();
  const add = (e: LexiconEntry) => {
    const names = [e.term, ...(e.aliases ?? [])];
    if (names.some((n) => seen.has(n.toLowerCase()))) return;
    for (const n of names) seen.add(n.toLowerCase());
    entries.push({ term: e.term, patterns: names.map((n) => termPattern(n, e.strict ?? false)) });
  };
  for (const e of lexicon) add(e);
  for (const s of userSkills) {
    const term = s.trim();
    if (term && term.length <= 40) add({ term, strict: term.length <= 2 });
  }
  return { entries };
}

/** A term bounded by anything that can't continue a tech token (letters, digits, + # . -); "C/C++" splits on the slash. */
export function termPattern(term: string, strict: boolean): RegExp {
  // One-letter languages (C, R) only count inside a list: "C, C++", "C/C++", "(C)".
  if (term.length === 1) return new RegExp(`(?<=[,/(]\\s*)${term}(?![A-Za-z0-9+#])|(?<![A-Za-z0-9+#.\\-/])${term}(?=\\s*[,/)])`);
  const body = term
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s-]+');
  return new RegExp(`(?<![A-Za-z0-9+#.\\-])${body}(?![A-Za-z0-9+#]|\\.[A-Za-z0-9]|-[A-Za-z0-9])`, strict ? '' : 'i');
}

export function findTerms(text: string, dict: Dictionary): Set<string> {
  const found = new Set<string>();
  for (const e of dict.entries) if (e.patterns.some((p) => p.test(text))) found.add(e.term);
  return found;
}

const HARD_HEADING =
  /\b(requirements?|qualifications?|must[- ]haves?|required|what you('|’)?ll need|what we('|’)?re looking for|you (have|bring|should have)|who you are|minimum|basic|skills (and|&) experience)\b/i;
const SOFT_HEADING = /\b(nice[- ]to[- ]haves?|preferred|bonus|plus(es)?|good[- ]to[- ]haves?|desired|desirable|extra credit)\b/i;
const OTHER_HEADING = /\b(about (us|the (company|team|role))|benefits|perks|what we offer|compensation|equal opportunity|our (company|mission|values)|why join)\b/i;

type Section = 'hard' | 'soft' | 'normal' | 'other';

/** Split a JD into lines tagged with the section they sit in. */
export function sectionLines(jd: string): Array<{ line: string; section: Section }> {
  const out: Array<{ line: string; section: Section }> = [];
  let section: Section = 'normal';
  for (const raw of jd.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const plain = line.replace(/^[#>*\-\s]+|[*:_\s]+$/g, '');
    const isHeading = /^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line) || (plain.length <= 60 && /:$/.test(line.replace(/\*+$/, '')));
    if (isHeading) {
      if (SOFT_HEADING.test(plain)) section = 'soft';
      else if (HARD_HEADING.test(plain)) section = 'hard';
      else if (OTHER_HEADING.test(plain)) section = 'other';
      else section = 'normal';
      continue;
    }
    // Inline signals override the section for that line.
    let s = section;
    if (/\b(nice to have|preferred|is a plus|a bonus|good to have)\b/i.test(line)) s = 'soft';
    else if (/\b(required|must have|must be|mandatory)\b/i.test(line)) s = 'hard';
    out.push({ line, section: s });
  }
  return out;
}

export interface ExtractOptions {
  dictionary: Dictionary;
  /** Inverse document frequency over the job corpus; enables TF-IDF phrases. */
  idf?: Idf;
  maxPhrases?: number;
}

export function extractJdKeywords(jd: string, opts: ExtractOptions): JdKeywords {
  const tierOf = new Map<string, KeywordTier>();
  const rank: Record<KeywordTier, number> = { hard: 3, normal: 2, soft: 1, phrase: 0 };
  for (const { line, section } of sectionLines(jd)) {
    if (section === 'other') continue;
    const tier: KeywordTier = section;
    for (const term of findTerms(line, opts.dictionary)) {
      const prev = tierOf.get(term);
      if (!prev || rank[tier] > rank[prev]) tierOf.set(term, tier);
    }
  }
  const keywords: JdKeyword[] = [...tierOf].map(([term, tier]) => ({ term, tier }));

  if (opts.idf) {
    const dictLower = new Set(opts.dictionary.entries.map((e) => e.term.toLowerCase()));
    const relevant = sectionLines(jd)
      .filter((l) => l.section !== 'other')
      .map((l) => l.line)
      .join('\n');
    for (const p of topPhrases(relevant, opts.idf, opts.maxPhrases ?? 6)) {
      if (dictLower.has(p) || keywords.some((k) => p.includes(k.term.toLowerCase()))) continue;
      keywords.push({ term: p, tier: 'phrase' });
    }
  }
  return { keywords };
}

// ---------------------------------------------------------------------------
// TF-IDF phrases
// ---------------------------------------------------------------------------

export interface Idf {
  docs: number;
  df: Map<string, number>;
}

const STOPWORDS = new Set(
  (
    'a an and are as at be by for from has have in is it its of on or that the to with will you your we our us ' +
    'this these those their they them who what when where which while can able work working team teams role ' +
    'experience years year strong good great excellent ability skills skill knowledge understanding including ' +
    'such other new etc using use used across within plus well also must should would could may help ' +
    'build building develop developing design designing related relevant preferred required requirements ' +
    'responsibilities qualifications job position candidate candidates company opportunity join looking ' +
    'environment based per day days time full part one two three more most all any each every both about into ' +
    'out over through up down not no if then than so do does did make makes making get gets'
  ).split(' '),
);

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9+#.-]*[a-z0-9+#]|[a-z]/g) ?? []).filter((t) => t.length > 1);
}

export function terms(text: string): string[] {
  const toks = tokens(text);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const a = toks[i]!;
    if (!STOPWORDS.has(a)) out.push(a);
    const b = toks[i + 1];
    if (b && !STOPWORDS.has(a) && !STOPWORDS.has(b)) out.push(`${a} ${b}`);
  }
  return out;
}

export function buildIdf(docs: string[]): Idf {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(terms(d))) df.set(t, (df.get(t) ?? 0) + 1);
  return { docs: docs.length, df };
}

/** Highest tf·idf terms of `text`; terms seen in fewer than 2 corpus docs are ignored as noise. */
export function topPhrases(text: string, idf: Idf, n: number): string[] {
  const tf = new Map<string, number>();
  for (const t of terms(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  const scored: Array<[string, number]> = [];
  for (const [t, f] of tf) {
    const df = idf.df.get(t) ?? 0;
    if (df < 2 || df > idf.docs * 0.5) continue;
    scored.push([t, f * Math.log(idf.docs / df)]);
  }
  // Prefer a bigram over its own words.
  for (const s of scored) if (s[0].includes(' ')) s[1] *= 1.5;
  const picked: string[] = [];
  for (const [t] of scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (picked.length >= n) break;
    if (picked.some((p) => p.split(' ').includes(t) || t.split(' ').includes(p))) continue;
    picked.push(t);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface Coverage {
  /** 0–100, weighted by tier; null when the JD yielded no keywords. */
  coverage: number | null;
  matched: string[];
  missing: string[];
  hardMissing: string[];
}

export function keywordCoverage(resumeText: string, jd: JdKeywords, dict: Dictionary): Coverage {
  if (!jd.keywords.length) return { coverage: null, matched: [], missing: [], hardMissing: [] };
  const inResume = findTerms(resumeText, dict);
  const lowerResume = ` ${tokens(resumeText).join(' ')} `;
  let total = 0;
  let got = 0;
  const matched: string[] = [];
  const missing: string[] = [];
  const hardMissing: string[] = [];
  for (const k of jd.keywords) {
    const w = TIER_WEIGHT[k.tier];
    total += w;
    const hit = k.tier === 'phrase' ? lowerResume.includes(` ${k.term} `) : inResume.has(k.term);
    if (hit) {
      got += w;
      matched.push(k.term);
    } else {
      missing.push(k.term);
      if (k.tier === 'hard') hardMissing.push(k.term);
    }
  }
  return { coverage: Math.round((got / total) * 100), matched, missing, hardMissing };
}
