import type { FactValidation, ProfileFact, TailoredBullet, TailoredHeader, ValidationIssue } from '@jobforge/plugin-sdk';

// Enforces PLAN.md §7 "Grounded tailoring rule": every bullet must only use
// facts from the fact bank, and may not introduce numbers / proper nouns /
// technologies not present in the source fact. Failing bullets are dropped.

export interface ValidationInput {
  bullets: TailoredBullet[];
  header: TailoredHeader;
  facts: ProfileFact[];
  /** Max characters per bullet (defaults to 220, so bullets fit one line). */
  bulletMaxChars?: number;
  /** Preferences-level allow list for header skills (adds to skills derived from facts). */
  allowedSkills?: string[];
}

export interface ValidationResult {
  bullets: TailoredBullet[];
  dropped: FactValidation[];
  report: FactValidation[];
  header: TailoredHeader;
  headerIssues: ValidationIssue[];
}

// Short common words we don't flag as "unknown terms" even if they look like
// proper nouns. Covers action verbs across tenses + generic connectives so a
// resume bullet's opening ("Served", "Pursuing", "Spearheaded") never trips the
// validator. Add technology names to the user's facts, not here.
const COMMON_STOPWORDS = new Set([
  'A', 'An', 'And', 'The', 'For', 'With', 'From', 'To', 'Of', 'In', 'On', 'At', 'By', 'Or', 'As', 'Up', 'Via',
  'I', 'My', 'We', 'Our', 'This', 'That', 'These', 'Those', 'Across', 'During', 'After', 'Before', 'Over',
  'Than', 'Into', 'Onto', 'Through', 'When', 'While', 'Where', 'Which', 'Who', 'What', 'Why', 'How',
  'Led', 'Leading', 'Leads', 'Lead',
  'Built', 'Building', 'Builds',
  'Shipped', 'Shipping', 'Ships',
  'Designed', 'Designing', 'Designs',
  'Delivered', 'Delivering', 'Delivers',
  'Reduced', 'Reducing', 'Reduces',
  'Improved', 'Improving', 'Improves',
  'Owned', 'Owning', 'Owns',
  'Scaled', 'Scaling', 'Scales',
  'Launched', 'Launching', 'Launches',
  'Implemented', 'Implementing', 'Implements',
  'Developed', 'Developing', 'Develops',
  'Automated', 'Automating', 'Automates',
  'Migrated', 'Migrating', 'Migrates',
  'Refactored', 'Refactoring', 'Refactors',
  'Optimized', 'Optimizing', 'Optimizes',
  'Deployed', 'Deploying', 'Deploys',
  'Integrated', 'Integrating', 'Integrates',
  'Managed', 'Managing', 'Manages',
  'Mentored', 'Mentoring', 'Mentors',
  'Collaborated', 'Collaborating', 'Collaborates',
  'Architected', 'Architecting', 'Architects',
  'Created', 'Creating', 'Creates',
  'Introduced', 'Introducing', 'Introduces',
  'Expanded', 'Expanding', 'Expands',
  'Analyzed', 'Analyzing', 'Analyzes',
  'Served', 'Serving', 'Serves', 'Serve',
  'Pursued', 'Pursuing', 'Pursues', 'Pursue',
  'Contributed', 'Contributing', 'Contributes',
  'Rewrote', 'Rewriting', 'Rewrites', 'Rewrite',
  'Wrote', 'Writing', 'Writes',
  'Added', 'Adding', 'Adds',
  'Removed', 'Removing', 'Removes',
  'Enabled', 'Enabling', 'Enables',
  'Supported', 'Supporting', 'Supports',
  'Maintained', 'Maintaining', 'Maintains',
  'Reviewed', 'Reviewing', 'Reviews',
  'Tested', 'Testing', 'Tests',
  'Trained', 'Training', 'Trains',
  'Fixed', 'Fixing', 'Fixes',
  'Streamlined', 'Streamlining',
  'Investigated', 'Investigating', 'Investigates',
  'Prototyped', 'Prototyping', 'Prototypes',
  'Rolled', 'Rolling', 'Rolls',
  'Benchmarked', 'Benchmarking', 'Benchmarks',
  'Measured', 'Measuring', 'Measures',
  'Monitored', 'Monitoring', 'Monitors',
  'Partnered', 'Partnering',
  'Spearheaded', 'Spearheading',
  'Drove', 'Driving', 'Drives',
  'Grew', 'Growing', 'Grows',
  'Shaped', 'Shaping',
  'Set', 'Setting', 'Sets',
  'Cut', 'Cutting', 'Cuts',
]);

/**
 * Tokens worth checking for groundedness: capitalized words that aren't a common
 * action verb or stopword, plus mixed-case / acronym tokens like `GoLang`, `AWS`.
 */
export function extractProperTerms(s: string): string[] {
  const toks = s.match(/[A-Za-z][A-Za-z0-9+.#-]{0,}/g) ?? [];
  const out: string[] = [];
  for (const t of toks) {
    if (COMMON_STOPWORDS.has(t)) continue;
    const isAcronym = /^[A-Z0-9+.#-]{2,}$/.test(t);
    const isCapitalized = /^[A-Z]/.test(t) && /[a-z]/.test(t);
    const hasInnerCap = /[a-z][A-Z]/.test(t);
    if (isAcronym || isCapitalized || hasInnerCap) out.push(t);
  }
  return out;
}

export function extractNumbers(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\b\d[\d.,]*(?:\s?[kKmMbB]|\s?%|\s?x)?/g)) out.push(m[0].replace(/\s/g, '').toLowerCase());
  return out;
}

function normalizedIncludes(haystack: string, needle: string): boolean {
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const h = flat(haystack);
  const n = flat(needle);
  return n.length > 0 && h.includes(n);
}

/**
 * A term is grounded if it, or every "proper" sub-token (capitalized / acronym),
 * is in the fact. Lowercase sub-parts of a hyphen compound are treated as
 * free adjectives ("Firestore-backed" passes when the fact mentions "Firestore";
 * "Google-Cloud" needs both; "Firestore-Spanner" is still caught if "Spanner"
 * is absent).
 */
function termIsGrounded(term: string, haystack: string): boolean {
  if (normalizedIncludes(haystack, term)) return true;
  const parts = term.split(/[-/]/).filter(Boolean);
  if (parts.length < 2) return false;
  const needGrounding = parts.filter(
    (p) => !COMMON_STOPWORDS.has(p) && (/^[A-Z0-9+.#]{2,}$/.test(p) || /^[A-Z]/.test(p)),
  );
  if (needGrounding.length === 0) return true;
  return needGrounding.every((p) => normalizedIncludes(haystack, p));
}

function factHaystack(f: ProfileFact): string {
  const metricValues = Object.entries(f.metrics)
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(' ');
  return [f.content, f.tags.join(' '), metricValues, f.id].join(' ');
}

function metricNumbers(f: ProfileFact): string[] {
  return Object.values(f.metrics).flatMap((v) => extractNumbers(String(v)));
}

export function validateBullet(bullet: TailoredBullet, factsById: Map<string, ProfileFact>, maxChars: number): FactValidation {
  const issues: ValidationIssue[] = [];
  const fact = factsById.get(bullet.factId);
  if (!fact) {
    issues.push({ kind: 'unknown_fact_id', detail: `fact id "${bullet.factId}" is not in the fact bank` });
    return { factId: bullet.factId, text: bullet.text, section: bullet.section, status: 'error', issues };
  }
  const text = bullet.text.trim();
  if (!text) issues.push({ kind: 'empty', detail: 'bullet text is empty' });
  if (text.length > maxChars) issues.push({ kind: 'too_long', detail: `${text.length} > ${maxChars} chars` });

  const haystack = factHaystack(fact);
  for (const term of extractProperTerms(text)) {
    if (termIsGrounded(term, haystack)) continue;
    issues.push({ kind: 'invented_term', detail: `"${term}" is not in fact ${fact.id}` });
  }
  const factNumbers = new Set([...extractNumbers(haystack), ...metricNumbers(fact)]);
  for (const n of extractNumbers(text)) {
    if (!factNumbers.has(n)) issues.push({ kind: 'invented_number', detail: `"${n}" is not in fact ${fact.id}` });
  }
  const errorKinds = new Set<ValidationIssue['kind']>(['unknown_fact_id', 'invented_number', 'invented_term', 'empty']);
  const status: FactValidation['status'] = issues.some((i) => errorKinds.has(i.kind))
    ? 'error'
    : issues.length
      ? 'warning'
      : 'ok';
  return { factId: bullet.factId, text, section: bullet.section, status, issues };
}

export function validateHeader(header: TailoredHeader, facts: ProfileFact[], allowedSkills: string[] = []): { header: TailoredHeader; issues: ValidationIssue[] } {
  const haystack = facts.map(factHaystack).join(' ');
  const issues: ValidationIssue[] = [];
  const allowed = new Set(allowedSkills.map((s) => s.toLowerCase()));
  const skills: string[] = [];
  for (const s of header.skills) {
    if (allowed.has(s.toLowerCase()) || normalizedIncludes(haystack, s)) skills.push(s);
    else issues.push({ kind: 'invented_term', detail: `skill "${s}" is not in the profile; dropped` });
  }
  for (const term of extractProperTerms(header.summary)) {
    if (!normalizedIncludes(haystack, term)) {
      issues.push({ kind: 'invented_term', detail: `summary mentions "${term}" which is not in the profile` });
    }
  }
  for (const n of extractNumbers(header.summary)) {
    const allowedNumbers = new Set([...extractNumbers(haystack), ...facts.flatMap(metricNumbers)]);
    if (!allowedNumbers.has(n)) issues.push({ kind: 'invented_number', detail: `summary mentions "${n}" which is not in the profile` });
  }
  return { header: { summary: header.summary.trim(), skills }, issues };
}

export function validate(input: ValidationInput): ValidationResult {
  const maxChars = input.bulletMaxChars ?? 220;
  const factsById = new Map(input.facts.map((f) => [f.id, f]));
  const kept: TailoredBullet[] = [];
  const dropped: FactValidation[] = [];
  const report: FactValidation[] = [];
  for (const b of input.bullets) {
    const v = validateBullet(b, factsById, maxChars);
    report.push(v);
    if (v.status === 'error') dropped.push(v);
    else kept.push({ factId: b.factId, text: v.text, section: b.section });
  }
  const { header, issues } = validateHeader(input.header, input.facts, input.allowedSkills);
  return { bullets: kept, dropped, report, header, headerIssues: issues };
}
