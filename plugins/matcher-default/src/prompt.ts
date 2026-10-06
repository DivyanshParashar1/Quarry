import { z } from 'zod';
import type { Job, Profile } from '@jobforge/plugin-sdk';

export const rubricItemSchema = z.object({
  ref: z.string().describe('The job ref exactly as given, e.g. "J3"'),
  stack_fit: z.number().int().min(0).max(10).describe('Overlap between the job’s required tech and the candidate’s stack and facts'),
  seniority_fit: z.number().int().min(0).max(10).describe('How well the level and years asked for match the candidate'),
  location_fit: z.number().int().min(0).max(10).describe('Location / remote arrangement vs. the candidate’s preferences'),
  eligibility: z
    .number()
    .int()
    .min(0)
    .max(10)
    .describe('10 = clearly eligible; low when work authorization, batch, degree, or clearance requirements likely exclude the candidate'),
  score: z.number().int().min(0).max(100).describe('Overall fit, 0-100'),
  reasons: z.string().min(1).max(700).describe('2-3 sentences citing specific requirements and specific candidate facts'),
  concerns: z.array(z.string().max(200)).max(4).describe('Concrete gaps or red flags; empty if none'),
});
export type RubricItem = z.infer<typeof rubricItemSchema>;

export const rubricResponseSchema = z.object({ results: z.array(rubricItemSchema) });

export const SYSTEM_PROMPT = `You are a meticulous technical recruiter scoring how well job postings fit one candidate.

Score each job independently against the candidate profile. Be calibrated and skeptical:
- 85-100: strong fit; the candidate meets nearly all core requirements and preferences.
- 70-84: good fit with minor gaps.
- 50-69: plausible stretch; notable gaps.
- 25-49: weak fit.
- 0-24: clearly unsuitable or the candidate is likely ineligible.
Ground every claim in the posting text and the candidate's listed facts. Never assume skills or experience the profile does not state. Eligibility problems (work authorization, required location, graduation batch, clearance) cap the score at 30.
Return exactly one result per job, using the job's ref.`;

export function candidateBlock(profile: Profile, maxFacts = 40): string {
  const p = profile.preferences;
  const lines = ['# Candidate'];
  const add = (label: string, v: string | null | undefined) => v && lines.push(`${label}: ${v}`);
  add('Target roles', p.roles.join(', '));
  add('Acceptable levels', p.seniority.join(', '));
  add('Preferred locations', p.locations.join(', '));
  add('Work arrangement', p.remote_policy.join(', '));
  add('Stack', p.stack.join(', '));
  add('Years of experience', p.experience_years?.toString());
  add('Graduation year', p.graduation_year?.toString());
  add('Salary floor', p.salary_floor ? `${p.salary_floor.amount} ${p.salary_floor.currency}/${p.salary_floor.period}` : null);
  add('Notes', p.notes);
  if (profile.facts.length) {
    lines.push('', '## Facts');
    for (const f of profile.facts.slice(0, maxFacts)) lines.push(`- (${f.kind}) ${f.content}`);
  }
  return lines.join('\n');
}

export function jobBlock(ref: string, job: Job, descriptionChars: number): string {
  const desc = (job.descriptionMd ?? '(no description)').replace(/\n{3,}/g, '\n\n');
  const meta = [
    `Company: ${job.company}`,
    job.locations.length ? `Location: ${job.locations.join('; ')}` : null,
    job.remotePolicy ? `Arrangement: ${job.remotePolicy}` : null,
    job.seniority ? `Level (from title): ${job.seniority}` : null,
  ].filter(Boolean);
  const body = desc.length > descriptionChars ? `${desc.slice(0, descriptionChars)}\n[...truncated]` : desc;
  return [`## ${ref}: ${job.title}`, ...meta, '', body].join('\n');
}

export function batchPrompt(profile: Profile, batch: { ref: string; job: Job }[], descriptionChars: number): string {
  return [
    candidateBlock(profile),
    '',
    `# Jobs (${batch.length})`,
    ...batch.map((b) => `${jobBlock(b.ref, b.job, descriptionChars)}\n`),
    `Score all ${batch.length} jobs: ${batch.map((b) => b.ref).join(', ')}.`,
  ].join('\n');
}
