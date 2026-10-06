import type { Job, Preferences } from '@jobforge/plugin-sdk';

// Hard filters: cheap, deterministic, explainable. A job that fails one never
// reaches the LLM. Each returns a human-readable reason, or null to pass.

export interface FilterOptions {
  /** Drop a job only when it asks for more than experience_years + this many years. */
  experienceSlackYears: number;
}

export type HardFilter = (job: Job, p: Preferences, o: FilterOptions) => string | null;

const lc = (s: string) => s.toLowerCase();
const wordRe = (kw: string) => new RegExp(`(^|[^a-z0-9])${kw.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);

export const excludedCompany: HardFilter = (job, p) => {
  const c = lc(job.company);
  const hit = p.exclusions.companies.find((x) => lc(x) === c || wordRe(x).test(c));
  return hit ? `Excluded company (${hit})` : null;
};

export const excludedTitle: HardFilter = (job, p) => {
  const t = lc(job.title);
  const hit = p.exclusions.title_keywords.find((k) => wordRe(k).test(t));
  return hit ? `Title contains excluded keyword "${hit}"` : null;
};

export const excludedDescription: HardFilter = (job, p) => {
  const d = lc(job.descriptionMd ?? '');
  const hit = p.exclusions.description_keywords.find((k) => d.includes(lc(k)));
  return hit ? `Description mentions excluded keyword "${hit}"` : null;
};

export const seniorityMismatch: HardFilter = (job, p) => {
  if (!p.seniority.length) return null;
  const level = job.seniority ?? 'mid';
  return (p.seniority as string[]).includes(level) ? null : `Level ${level} is not in ${p.seniority.join('/')}`;
};

export const locationMismatch: HardFilter = (job, p) => {
  const allowsRemote = !p.remote_policy.length || p.remote_policy.includes('remote');
  if (job.remotePolicy && p.remote_policy.length && !p.remote_policy.includes(job.remotePolicy)) {
    return `${cap(job.remotePolicy)} roles are not in ${p.remote_policy.join('/')}`;
  }
  if (job.remotePolicy === 'remote' && allowsRemote) return null;
  if (!p.locations.length || !job.locations.length) return null;
  const wanted = p.locations.map(lc);
  const ok = job.locations.some((l) => wanted.some((w) => lc(l).includes(w)));
  return ok ? null : `Location ${job.locations.slice(0, 3).join('; ')} is outside ${p.locations.join('/')}`;
};

const BATCH_PATTERNS = [
  /\b((?:20\d\d)(?:\s*(?:\/|,|&|and|or|-)\s*(?:20)?\d\d)*)\s*(?:batch|grads?|graduates?|pass[\s-]?outs?|passing out)\b/gi,
  /\b(?:batch|class)\s*(?:of\s*)?((?:20\d\d)(?:\s*(?:\/|,|&|and|or|-)\s*(?:20)?\d\d)*)/gi,
  /\bgraduat(?:e|es|ing|ion)\s+(?:in|by|year|year of)?\s*:?\s*((?:20\d\d)(?:\s*(?:\/|,|&|and|or|-)\s*(?:20)?\d\d)*)/gi,
];

/** Years a posting restricts eligibility to ("2025 batch", "class of 2026", "graduating in 2024/25"). */
export function eligibleBatches(text: string): number[] {
  const years = new Set<number>();
  for (const re of BATCH_PATTERNS) {
    for (const m of text.matchAll(re)) {
      for (const y of m[1]!.match(/\d{2,4}/g) ?? []) {
        const n = y.length === 2 ? 2000 + Number(y) : Number(y);
        if (n >= 2000 && n < 2100) years.add(n);
      }
    }
  }
  return [...years].sort();
}

export const batchMismatch: HardFilter = (job, p) => {
  if (p.graduation_year === null) return null;
  const years = eligibleBatches(`${job.title}\n${job.descriptionMd ?? ''}`);
  if (!years.length || years.includes(p.graduation_year)) return null;
  return `Restricted to ${years.join('/')} batch; you graduate(d) in ${p.graduation_year}`;
};

const EXPERIENCE_RE =
  /\b(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)\b(?:\s+(?:of\s+)?[a-z/&-]+){0,4}?\s+(?:experience|exp)\b/gi;

/** The largest "N+ years of ... experience" minimum in a description, or null. */
export function requiredYears(text: string): number | null {
  let max: number | null = null;
  for (const m of text.matchAll(EXPERIENCE_RE)) {
    const n = Number(m[1]);
    if (n <= 30) max = Math.max(max ?? 0, n);
  }
  return max;
}

export const experienceMismatch: HardFilter = (job, p, o) => {
  if (p.experience_years === null) return null;
  const need = requiredYears(job.descriptionMd ?? '');
  if (need === null || need <= p.experience_years + o.experienceSlackYears) return null;
  return `Asks for ${need}+ years of experience; you have ${p.experience_years}`;
};

export const HARD_FILTERS: HardFilter[] = [
  excludedCompany,
  excludedTitle,
  seniorityMismatch,
  locationMismatch,
  batchMismatch,
  experienceMismatch,
  excludedDescription,
];

/** First failing filter's reason, or null when the job passes all of them. */
export function applyHardFilters(job: Job, p: Preferences, o: FilterOptions): string | null {
  for (const f of HARD_FILTERS) {
    const reason = f(job, p, o);
    if (reason) return reason;
  }
  return null;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
