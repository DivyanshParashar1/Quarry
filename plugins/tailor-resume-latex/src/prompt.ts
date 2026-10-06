import type { Job, Profile, TailoredResume } from '@jobforge/plugin-sdk';
import { tailoredResumeSchema } from '@jobforge/plugin-sdk';
import { z } from 'zod';

/**
 * The tailor returns the resume shape plus a self-reported `confidence` 0..1
 * that the autopilot uses to decide whether to auto-send without human review.
 */
export const outputSchema = tailoredResumeSchema.extend({
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('How confident you are this resume is a strong, grounded fit. 1 = send without human review; <0.75 = escalate.'),
});
export type TailoredOutput = z.infer<typeof outputSchema>;
export type TailoredCore = TailoredResume;

export const SYSTEM_PROMPT = `You are a careful resume writer who tailors ONE candidate's resume for ONE job.

Rules (non-negotiable; the system validates and discards bullets that break them):
- You may ONLY use facts from the candidate's fact bank. Every bullet must cite the fact id it came from. Never invent experience, projects, companies, dates, or numbers.
- You may rephrase, reorder, and select facts. You may NOT introduce numbers, technologies, companies, or named claims that are not in the source fact's content or metrics.
- Prefer facts most relevant to the job's requirements. Drop irrelevant ones.
- Keep each bullet concise (one line, roughly 15-28 words). Lead with an action verb.
- Section names must be one of: Experience, Projects, Education, Achievements, Skills (use the one matching the fact's kind).
- The summary is 1-2 sentences; do not restate the headline; do not invent experience.
- Skills must be drawn from the candidate's listed stack or skill facts; order by relevance to the job.

Also return a self-reported "confidence" 0..1. Base it on: how strong the match is, how many bullets you dropped, and whether the candidate clearly meets the role's must-haves. Score < 0.75 if anything feels forced or you had to stretch.

Return exactly the JSON shape asked for.`;

export function tailorPrompt(job: Job, profile: Profile, maxBullets: number): string {
  const p = profile.preferences;
  const lines: string[] = [];
  lines.push('# Target job', `Company: ${job.company}`, `Title: ${job.title}`);
  if (job.locations.length) lines.push(`Locations: ${job.locations.join('; ')}`);
  if (job.remotePolicy) lines.push(`Arrangement: ${job.remotePolicy}`);
  if (job.seniority) lines.push(`Level (from title): ${job.seniority}`);
  lines.push('', '## Description', (job.descriptionMd ?? '(no description)').slice(0, 5000));

  lines.push('', '# Candidate');
  if (p.roles.length) lines.push(`Target roles: ${p.roles.join(', ')}`);
  if (p.stack.length) lines.push(`Stack: ${p.stack.join(', ')}`);
  if (p.seniority.length) lines.push(`Levels: ${p.seniority.join(', ')}`);
  if (p.experience_years != null) lines.push(`Years: ${p.experience_years}`);
  if (p.notes) lines.push(`Notes: ${p.notes}`);

  lines.push('', '## Fact bank');
  if (!profile.facts.length) lines.push('(none — the candidate has not loaded any facts)');
  for (const f of profile.facts) {
    const metrics = Object.keys(f.metrics).length ? ` metrics=${JSON.stringify(f.metrics)}` : '';
    const tags = f.tags.length ? ` tags=[${f.tags.join(', ')}]` : '';
    lines.push(`- id=${f.id} kind=${f.kind}${tags}${metrics}`);
    lines.push(`  ${f.content}`);
  }

  lines.push(
    '',
    `Select up to ${maxBullets} bullets, in display order, choosing the facts most relevant to this job.`,
    'Return the JSON with header, bullets (each citing a fact id), and your self-reported confidence.',
  );
  return lines.join('\n');
}
