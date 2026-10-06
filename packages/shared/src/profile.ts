import { createHash } from 'node:crypto';
import { z } from 'zod';

// Candidate profile: profile/facts.yaml + profile/preferences.yaml (PLAN.md §7).

export const FACT_KINDS = ['project', 'experience', 'education', 'skill', 'achievement'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const factSchema = z
  .object({
    /** Stable id that tailored bullets cite. Never reuse an id for a different fact. */
    id: z.string().regex(/^[a-z0-9][a-z0-9-_.]*$/, 'lowercase letters, digits, - _ . only'),
    kind: z.enum(FACT_KINDS),
    content: z.string().trim().min(1),
    metrics: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    tags: z.array(z.string()).default([]),
  })
  .strict();
export type ProfileFact = z.infer<typeof factSchema>;

export const factsFileSchema = z
  .object({ facts: z.array(factSchema).nullable().default([]) })
  .transform((f) => f.facts ?? [])
  .superRefine((facts, ctx) => {
    const seen = new Set<string>();
    facts.forEach((f, i) => {
      if (seen.has(f.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `duplicate fact id ${f.id}` });
      seen.add(f.id);
    });
  });

/** Levels the normalizer infers from titles, plus `mid` for titles with no level marker. */
export const SENIORITY_LEVELS = [
  'intern',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'lead',
  'manager',
  'director',
  'executive',
] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

const list = <T extends z.ZodTypeAny>(t: T) => z.array(t).nullable().default([]).transform((x) => x ?? []);

export const preferencesSchema = z
  .object({
    /** Target roles, e.g. "Backend Engineer". Used for the similarity prefilter and the LLM rubric. */
    roles: list(z.string()),
    /** Acceptable levels; empty = any. Jobs with no level marker in the title count as `mid`. */
    seniority: list(z.enum(SENIORITY_LEVELS)),
    /** Acceptable locations (case-insensitive substring match against job locations); empty = any. */
    locations: list(z.string()),
    /** Acceptable work arrangements; empty = any. A remote job passes the location filter when `remote` is allowed. */
    remote_policy: list(z.enum(['remote', 'hybrid', 'onsite'])),
    stack: list(z.string()),
    salary_floor: z
      .object({
        amount: z.number().positive(),
        currency: z.string().default('INR'),
        period: z.enum(['year', 'month']).default('year'),
      })
      .nullable()
      .default(null),
    /** Years of professional experience; used to drop jobs that ask for far more. */
    experience_years: z.number().nonnegative().nullable().default(null),
    /** Graduation year ("batch"); jobs restricted to other batches are dropped. */
    graduation_year: z.number().int().min(1950).max(2100).nullable().default(null),
    exclusions: z
      .object({
        companies: list(z.string()),
        title_keywords: list(z.string()),
        description_keywords: list(z.string()),
      })
      .nullable()
      .default({})
      .transform((e) => e ?? { companies: [], title_keywords: [], description_keywords: [] }),
    /** Anything else the matcher should weigh, in plain words. */
    notes: z.string().nullable().default(null),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;

/** The profile as stages see it: the active snapshot plus its facts. */
export interface Profile {
  version: string;
  preferences: Preferences;
  facts: ProfileFact[];
  /** Text embedded for the job-similarity prefilter. */
  summary: string;
  embedding: number[] | null;
}

/** Content hash over facts + preferences; identical inputs give the same version. */
export function profileVersion(facts: ProfileFact[], preferences: Preferences): string {
  const canonical = JSON.stringify({ facts: [...facts].sort((a, b) => a.id.localeCompare(b.id)), preferences }, sortKeys);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function factHash(f: ProfileFact): string {
  return createHash('sha256')
    .update(JSON.stringify({ kind: f.kind, content: f.content, metrics: f.metrics, tags: f.tags }, sortKeys))
    .digest('hex');
}

/**
 * What gets embedded to represent the candidate: target roles and stack first
 * (they matter most for similarity), then skills and the most recent experience.
 */
export function profileSummary(facts: ProfileFact[], p: Preferences): string {
  const lines: string[] = [];
  if (p.roles.length) lines.push(`Target roles: ${p.roles.join(', ')}.`);
  if (p.seniority.length) lines.push(`Level: ${p.seniority.join(', ')}.`);
  if (p.stack.length) lines.push(`Tech stack: ${p.stack.join(', ')}.`);
  const skills = facts.filter((f) => f.kind === 'skill').map((f) => f.content);
  if (skills.length) lines.push(`Skills: ${skills.join('; ')}.`);
  for (const f of facts.filter((f) => f.kind === 'experience' || f.kind === 'project').slice(0, 6)) {
    lines.push(f.content);
  }
  return lines.join('\n');
}

function sortKeys(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  }
  return v;
}
