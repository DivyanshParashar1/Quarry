import { z } from 'zod';

// Grounded tailoring (PLAN.md §7): every output bullet carries the fact id it
// came from, and the core's validator checks the bullet introduces no numbers,
// technologies, or named claims that aren't in the source fact.

export const validationStatusSchema = z.enum(['ok', 'warning', 'error']);
export type ValidationStatus = z.infer<typeof validationStatusSchema>;

export const validationIssueSchema = z.object({
  kind: z.enum(['unknown_fact_id', 'invented_number', 'invented_term', 'too_long', 'empty']),
  detail: z.string(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const factValidationSchema = z.object({
  factId: z.string(),
  text: z.string(),
  section: z.string(),
  status: validationStatusSchema,
  issues: z.array(validationIssueSchema),
});
export type FactValidation = z.infer<typeof factValidationSchema>;

export const bulletSchema = z.object({
  /** Must match an id in profile.facts. */
  factId: z.string().min(1),
  /** Rephrased bullet, at most ~200 chars; must only reference content from the source fact. */
  text: z.string().trim().min(3).max(400),
  /** Which resume section the bullet belongs under (e.g. "Experience", "Projects"). */
  section: z.string().trim().min(1).max(60),
});
export type TailoredBullet = z.infer<typeof bulletSchema>;

export const headerSchema = z.object({
  /** 1-2 sentence summary / headline tailored to the job. Must not invent experience. */
  summary: z.string().trim().max(400),
  /** Headline skills ordered by relevance. Only skills present in the profile facts/preferences. */
  skills: z.array(z.string().trim().min(1).max(40)).max(20),
});
export type TailoredHeader = z.infer<typeof headerSchema>;

export const tailoredResumeSchema = z.object({
  header: headerSchema,
  bullets: z.array(bulletSchema).min(1).max(20),
});
export type TailoredResume = z.infer<typeof tailoredResumeSchema>;
