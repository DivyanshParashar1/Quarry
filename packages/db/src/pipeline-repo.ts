import { and, asc, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { DB } from './client.js';
import { companies, events, jobPipelineState, jobReferralBatches, jobs, reviewItems } from './schema.js';

export type PipelineState = (typeof jobPipelineState.state.enumValues)[number];
export const PIPELINE_STATES = jobPipelineState.state.enumValues;
export const TERMINAL_STATES: PipelineState[] = ['applied', 'expired', 'failed'];
export type PipelineRow = typeof jobPipelineState.$inferSelect;

export async function getPipelineState(db: DB, jobId: string): Promise<PipelineRow | null> {
  const [r] = await db.select().from(jobPipelineState).where(eq(jobPipelineState.jobId, jobId));
  return r ?? null;
}

/** Take a job on (idempotent: an existing row is left alone). */
export async function enterPipeline(db: DB, jobId: string, metadata: Record<string, unknown>, at = new Date()): Promise<boolean> {
  const rows = await db
    .insert(jobPipelineState)
    .values({ jobId, state: 'candidate', enteredStateAt: at, metadata })
    .onConflictDoNothing()
    .returning({ jobId: jobPipelineState.jobId });
  if (rows.length) {
    await db.insert(events).values({ kind: 'pipeline.transition', subjectType: 'job', subjectId: jobId, payload: { from: null, to: 'candidate', ...metadata } });
  }
  return rows.length > 0;
}

/**
 * Move a job from one of `from` to `to`, merging `metadata`, and record the
 * transition. Returns null when the job wasn't in an expected state (a
 * concurrent or repeated run already moved it): callers just skip.
 */
export async function transitionPipeline(
  db: DB,
  jobId: string,
  from: PipelineState[],
  to: PipelineState,
  reason: string,
  metadata: Record<string, unknown> = {},
  at = new Date(),
): Promise<PipelineRow | null> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(jobPipelineState).where(and(eq(jobPipelineState.jobId, jobId), inArray(jobPipelineState.state, from))).for('update');
    if (!cur) return null;
    const [row] = await tx
      .update(jobPipelineState)
      .set({ state: to, enteredStateAt: at, metadata: { ...(cur.metadata as object), ...metadata, reason }, updatedAt: new Date() })
      .where(eq(jobPipelineState.jobId, jobId))
      .returning();
    await tx.insert(events).values({ kind: 'pipeline.transition', subjectType: 'job', subjectId: jobId, payload: { from: cur.state, to, reason, ...metadata } });
    return row ?? null;
  });
}

/** Merge metadata without changing state (e.g. the apply review item id). */
export async function updatePipelineMetadata(db: DB, jobId: string, metadata: Record<string, unknown>): Promise<void> {
  await db
    .update(jobPipelineState)
    .set({ metadata: sql`${jobPipelineState.metadata} || ${JSON.stringify(metadata)}::jsonb`, updatedAt: new Date() })
    .where(eq(jobPipelineState.jobId, jobId));
}

export async function jobsInState(db: DB, states: PipelineState[], limit = 500): Promise<PipelineRow[]> {
  return db.select().from(jobPipelineState).where(inArray(jobPipelineState.state, states)).orderBy(asc(jobPipelineState.enteredStateAt)).limit(limit);
}

export async function pipelineStateCounts(db: DB): Promise<Record<PipelineState, number>> {
  const rows = await db.select({ state: jobPipelineState.state, n: sql<number>`count(*)::int` }).from(jobPipelineState).groupBy(jobPipelineState.state);
  const out = Object.fromEntries(PIPELINE_STATES.map((s) => [s, 0])) as Record<PipelineState, number>;
  for (const r of rows) out[r.state] = r.n;
  return out;
}

export interface ApplicationRow {
  jobId: string;
  title: string;
  company: string;
  companyId: string;
  applyUrl: string | null;
  state: PipelineState;
  enteredStateAt: Date;
  metadata: Record<string, unknown>;
  inferredDeadline: string | null;
  deadlineConfidence: number | null;
  closedAt: Date | null;
  batch: { status: string; requested: number; drafted: number; sent: number; replied: number; firstSentAt: Date | null } | null;
  applicationStatus: string | null;
}

/** Every job the sequencer has taken on, for the /applications audit page. */
export async function listApplications(db: DB, f: { states?: PipelineState[]; company?: string; limit?: number; offset?: number } = {}): Promise<{ rows: ApplicationRow[]; total: number }> {
  const conds = [
    f.states?.length ? inArray(jobPipelineState.state, f.states) : undefined,
    f.company ? ilike(companies.name, `%${f.company}%`) : undefined,
  ];
  const where = and(...conds);
  const rows = await db
    .select({
      jobId: jobPipelineState.jobId,
      title: jobs.title,
      company: companies.name,
      companyId: companies.id,
      applyUrl: jobs.applyUrl,
      state: jobPipelineState.state,
      enteredStateAt: jobPipelineState.enteredStateAt,
      metadata: jobPipelineState.metadata,
      inferredDeadline: jobs.inferredDeadline,
      deadlineConfidence: jobs.deadlineConfidence,
      closedAt: jobs.closedAt,
      bStatus: jobReferralBatches.status,
      bRequested: jobReferralBatches.requestedCount,
      bDrafted: jobReferralBatches.draftedCount,
      bSent: jobReferralBatches.sentCount,
      bReplied: jobReferralBatches.repliedCount,
      bFirstSent: jobReferralBatches.firstSentAt,
      applicationStatus: sql<string | null>`(select r.status::text from ${reviewItems} r where r.job_id = ${jobs.id} and r.kind = 'application' order by r.created_at desc limit 1)`,
    })
    .from(jobPipelineState)
    .innerJoin(jobs, eq(jobs.id, jobPipelineState.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(jobReferralBatches, eq(jobReferralBatches.jobId, jobs.id))
    .where(where)
    .orderBy(desc(jobPipelineState.updatedAt))
    .limit(f.limit ?? 100)
    .offset(f.offset ?? 0);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobPipelineState)
    .innerJoin(jobs, eq(jobs.id, jobPipelineState.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(where);
  return {
    total: count!.n,
    rows: rows.map((r) => ({
      jobId: r.jobId,
      title: r.title,
      company: r.company,
      companyId: r.companyId,
      applyUrl: r.applyUrl,
      state: r.state,
      enteredStateAt: r.enteredStateAt,
      metadata: r.metadata as Record<string, unknown>,
      inferredDeadline: r.inferredDeadline,
      deadlineConfidence: r.deadlineConfidence,
      closedAt: r.closedAt,
      batch: r.bStatus
        ? { status: r.bStatus, requested: r.bRequested!, drafted: r.bDrafted!, sent: r.bSent!, replied: r.bReplied!, firstSentAt: r.bFirstSent }
        : null,
      applicationStatus: r.applicationStatus,
    })),
  };
}

export interface TimelineEntry {
  at: Date;
  kind: string;
  summary: string;
  data: Record<string, unknown>;
}

/** A job's full history: state transitions, job events, and every review item about it (with its decisions). */
export async function jobTimeline(db: DB, jobId: string): Promise<TimelineEntry[]> {
  const evs = await db
    .select()
    .from(events)
    .where(
      sql`(${events.subjectType} = 'job' and ${events.subjectId} = ${jobId})
        or (${events.subjectType} = 'review_item' and ${events.subjectId} in (select id::text from ${reviewItems} where job_id = ${jobId}))`,
    )
    .orderBy(asc(events.createdAt))
    .limit(1000);
  const items = await db
    .select({ id: reviewItems.id, kind: reviewItems.kind, status: reviewItems.status, pluginId: reviewItems.pluginId, createdAt: reviewItems.createdAt, decidedAt: reviewItems.decidedAt, decidedBy: reviewItems.decidedBy, contactId: reviewItems.contactId })
    .from(reviewItems)
    .where(eq(reviewItems.jobId, jobId));
  const kinds = new Map(items.map((i) => [i.id, i]));
  const out: TimelineEntry[] = evs.map((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const item = e.subjectType === 'review_item' && e.subjectId ? kinds.get(e.subjectId) : undefined;
    let summary = e.kind;
    if (e.kind === 'pipeline.transition') summary = `${String(p.from ?? '∅')} → ${String(p.to)}${p.reason ? ` (${String(p.reason)})` : ''}`;
    else if (item) summary = `${item.kind.replace('_', ' ')} ${e.kind.split('.').pop()} (${item.pluginId})`;
    return { at: e.createdAt, kind: e.kind, summary, data: { ...p, ...(item ? { reviewItemId: item.id, status: item.status } : {}) } };
  });
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
