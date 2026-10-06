// Email local-part patterns. Priors are rough shares across company domains
// (first.last dominates); they only matter when no address at the domain is known.

export const PATTERNS = [
  { pattern: '{first}.{last}', prior: 0.38 },
  { pattern: '{first}', prior: 0.16 },
  { pattern: '{f}{last}', prior: 0.15 },
  { pattern: '{first}{last}', prior: 0.07 },
  { pattern: '{f}.{last}', prior: 0.05 },
  { pattern: '{first}_{last}', prior: 0.03 },
  { pattern: '{first}{l}', prior: 0.03 },
  { pattern: '{last}', prior: 0.02 },
  { pattern: '{last}.{first}', prior: 0.02 },
  { pattern: '{first}-{last}', prior: 0.02 },
  { pattern: '{last}{f}', prior: 0.01 },
] as const;
export type Pattern = (typeof PATTERNS)[number]['pattern'] | (string & {});

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'mba']);

/** "Dr. José María García-López Jr." -> { first: 'jose', last: 'garcialopez' }. */
export function nameParts(name: string): { first: string; last: string | null } | null {
  const tokens = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(dr|mr|mrs|ms|prof)\.?\s+/g, '')
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z]/g, ''))
    .filter((t) => t && !SUFFIXES.has(t));
  if (!tokens.length) return null;
  return { first: tokens[0]!, last: tokens.length > 1 ? tokens[tokens.length - 1]! : null };
}

/** Apply a pattern to a name; null when the pattern needs a last name we don't have. */
export function applyPattern(pattern: string, name: string): string | null {
  const p = nameParts(name);
  if (!p) return null;
  if (!p.last && /\{l(ast)?\}/.test(pattern)) return null;
  return pattern
    .replace('{first}', p.first)
    .replace('{last}', p.last ?? '')
    .replace('{f}', p.first[0]!)
    .replace('{l}', p.last?.[0] ?? '');
}

/** Patterns that generate this exact local part for this name. */
export function patternsMatching(localPart: string, name: string): string[] {
  const lp = localPart.toLowerCase();
  return PATTERNS.map((p) => p.pattern).filter((p) => applyPattern(p, name) === lp);
}

export interface PatternEvidence {
  name: string;
  email: string;
  /** false = this address bounced. */
  delivered: boolean;
}

export interface PatternChoice {
  pattern: string;
  confidence: number;
  basis: 'known_addresses' | 'prior' | 'configured';
  samples: number;
}

/**
 * Pick the company's pattern. Known, delivered addresses vote for the patterns
 * that reproduce them; a bounced address rules out the pattern that produced it.
 */
export function choosePattern(evidence: PatternEvidence[], configured?: string): PatternChoice {
  if (configured) return { pattern: configured, confidence: 0.9, basis: 'configured', samples: 0 };
  const excluded = new Set<string>();
  const votes = new Map<string, number>();
  let samples = 0;
  for (const e of evidence) {
    const local = e.email.split('@')[0] ?? '';
    const matches = patternsMatching(local, e.name);
    if (!e.delivered) {
      matches.forEach((m) => excluded.add(m));
      continue;
    }
    if (!matches.length) continue;
    samples++;
    for (const m of matches) votes.set(m, (votes.get(m) ?? 0) + 1 / matches.length);
  }
  const ranked = [...votes.entries()].filter(([p]) => !excluded.has(p)).sort((a, b) => b[1] - a[1]);
  if (ranked.length && samples > 0) {
    const [pattern, v] = ranked[0]!;
    const agreement = v / samples;
    const confidence = Math.min(0.95, 0.55 + 0.4 * agreement * (Math.min(samples, 3) / 3));
    return { pattern, confidence: round(confidence), basis: 'known_addresses', samples };
  }
  const prior = PATTERNS.find((p) => !excluded.has(p.pattern)) ?? PATTERNS[0];
  // A guess from priors alone is never better than a coin flip.
  return { pattern: prior.pattern, confidence: round(Math.min(0.4, prior.prior)), basis: 'prior', samples: 0 };
}

export function normalizeDomain(d: string | null | undefined): string | null {
  if (!d) return null;
  const host = d
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
