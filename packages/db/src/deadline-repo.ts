import { and, asc, eq, gte, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { DB } from './client.js';
import { jobs, matchResults } from './schema.js';

export interface DeadlineRecord {
  deadline: string | null;
  confidence: number;
  rationale: string;
  sources: string[];
}

export async function saveDeadline(db: DB, jobId: string, d: DeadlineRecord, at = new Date()): Promise<void> {
  await db
    .update(jobs)
    .set({
      inferredDeadline: d.deadline,
      deadlineConfidence: d.confidence,
      deadlineRationale: d.rationale,
      deadlineSources: d.sources,
      deadlineInferredAt: at,
    })
    .where(eq(jobs.id, jobId));
}

/**
 * Open jobs due a deadline estimate: never inferred, or inferred before
 * `staleBefore`. Only jobs the matcher scored at least `minScore` for the
 * active profile are worth a web search.
 */
export async function jobsNeedingDeadline(
  db: DB,
  f: { profileVersion: string | null; minScore: number; staleBefore: Date; limit: number; jobIds?: string[] },
): Promise<{ id: string }[]> {
  if (f.jobIds?.length) {
    return db.select({ id: jobs.id }).from(jobs).where(and(isNull(jobs.closedAt), sql`${jobs.id} in ${f.jobIds}`));
  }
  if (!f.profileVersion) return [];
  return db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(matchResults, and(eq(matchResults.jobId, jobs.id), eq(matchResults.profileVersion, f.profileVersion)))
    .where(
      and(
        isNull(jobs.closedAt),
        eq(matchResults.method, 'llm'),
        gte(matchResults.score, f.minScore),
        or(isNull(jobs.deadlineInferredAt), lt(jobs.deadlineInferredAt, f.staleBefore)),
      ),
    )
    .orderBy(sql`${matchResults.score} desc`, asc(jobs.firstSeenAt))
    .limit(f.limit);
}

/**
 * Close open jobs whose inferred deadline (with enough confidence) passed more
 * than `graceDays` ago. They stay closed even if a board still lists them
 * (closed_reason = deadline), so the autopilot leaves them alone.
 */
export async function closeExpiredDeadlines(db: DB, today: string, opts: { minConfidence: number; graceDays: number }): Promise<{ id: string }[]> {
  return db
    .update(jobs)
    .set({ closedAt: new Date(), closedReason: 'deadline' })
    .where(
      and(
        isNull(jobs.closedAt),
        sql`${jobs.inferredDeadline} is not null`,
        lte(jobs.inferredDeadline, sql`(${today}::date - ${opts.graceDays}::int)`),
        gte(jobs.deadlineConfidence, opts.minConfidence),
      ),
    )
    .returning({ id: jobs.id });
}
