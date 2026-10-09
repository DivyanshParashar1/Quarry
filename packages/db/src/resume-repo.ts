import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { DB } from './client.js';
import {
  jobResume,
  jobs,
  resumeBenchmarkCategories,
  resumeBenchmarkJobs,
  resumeBenchmarkScores,
  resumeVariants,
} from './schema.js';

export type ResumeVariantRow = typeof resumeVariants.$inferSelect;
export type ResumeStatus = ResumeVariantRow['status'];

export type ResumeKind = ResumeVariantRow['kind'];

export interface NewResumeVariant {
  /** Null for library resumes (combo/base). */
  jobId: string | null;
  profileVersion: string;
  pluginId: string;
  templateId: string;
  factIds: string[];
  bullets: unknown;
  header: unknown;
  validationReport: unknown;
  status: ResumeStatus;
  pdfPath: string | null;
  pdfBytes: number | null;
  provider: string | null;
  model: string | null;
  error: string | null;
  confidence: number | null;
  /** Phase 15 fit-loop result; null when the compile failed. */
  fit?: unknown;
  kind?: ResumeKind;
  comboKey?: string | null;
  label?: string | null;
  parentVariantId?: string | null;
  atsScore?: unknown;
  resumeText?: string | null;
  embedding?: number[] | null;
}

export async function insertResumeVariant(db: DB, v: NewResumeVariant): Promise<ResumeVariantRow> {
  const [row] = await db.insert(resumeVariants).values(v).returning();
  return row!;
}

export async function getResumeVariant(db: DB, id: string): Promise<ResumeVariantRow | null> {
  const [r] = await db.select().from(resumeVariants).where(eq(resumeVariants.id, id));
  return r ?? null;
}

export async function listResumeVariantsForJob(db: DB, jobId: string): Promise<ResumeVariantRow[]> {
  return db
    .select()
    .from(resumeVariants)
    .where(eq(resumeVariants.jobId, jobId))
    .orderBy(desc(resumeVariants.createdAt));
}

/**
 * The resume a job should use (apply, outreach attachments): the selector's
 * decision (`job_resume`) when there is one, else the most recent rendered
 * variant made for the job.
 */
export async function latestRenderedResumeForJob(db: DB, jobId: string): Promise<ResumeVariantRow | null> {
  const [chosen] = await db
    .select({ v: resumeVariants })
    .from(jobResume)
    .innerJoin(resumeVariants, eq(resumeVariants.id, jobResume.variantId))
    .where(and(eq(jobResume.jobId, jobId), eq(resumeVariants.status, 'rendered')));
  if (chosen) return chosen.v;
  const [r] = await db
    .select()
    .from(resumeVariants)
    .where(and(eq(resumeVariants.jobId, jobId), eq(resumeVariants.status, 'rendered')))
    .orderBy(desc(resumeVariants.createdAt))
    .limit(1);
  return r ?? null;
}

// ---------------------------------------------------------------------------
// Phase 16: resume library, selector decisions, benchmarks
// ---------------------------------------------------------------------------

export const LIBRARY_KINDS: ResumeKind[] = ['combo', 'base'];

/** Library resumes (combo/base), newest first. Retired ones only when asked. */
export async function listLibraryResumes(db: DB, opts: { includeRetired?: boolean } = {}): Promise<ResumeVariantRow[]> {
  const conds = [inArray(resumeVariants.kind, LIBRARY_KINDS)];
  if (!opts.includeRetired) conds.push(isNull(resumeVariants.retiredAt));
  return db
    .select()
    .from(resumeVariants)
    .where(and(...conds))
    .orderBy(desc(resumeVariants.createdAt));
}

/** Retire every active library resume except `keep`. Returns how many were retired. */
export async function retireLibraryResumes(db: DB, keep: string[] = []): Promise<number> {
  const conds = [inArray(resumeVariants.kind, LIBRARY_KINDS), isNull(resumeVariants.retiredAt)];
  if (keep.length) conds.push(notInArray(resumeVariants.id, keep));
  const rows = await db
    .update(resumeVariants)
    .set({ retiredAt: new Date() })
    .where(and(...conds))
    .returning({ id: resumeVariants.id });
  return rows.length;
}

export async function updateResumeScoring(
  db: DB,
  id: string,
  patch: { resumeText?: string | null; embedding?: number[] | null; atsScore?: unknown },
): Promise<void> {
  await db.update(resumeVariants).set(patch).where(eq(resumeVariants.id, id));
}

export type JobResumeRow = typeof jobResume.$inferSelect;

export async function getJobResume(db: DB, jobId: string): Promise<JobResumeRow | null> {
  const [r] = await db.select().from(jobResume).where(eq(jobResume.jobId, jobId));
  return r ?? null;
}

export async function setJobResume(
  db: DB,
  r: { jobId: string; variantId: string; comboVariantId: string | null; selectorScore: number | null; decision: unknown },
): Promise<JobResumeRow> {
  const values = { ...r, decidedAt: new Date() };
  const [row] = await db
    .insert(jobResume)
    .values(values)
    .onConflictDoUpdate({ target: jobResume.jobId, set: values })
    .returning();
  return row!;
}

export type BenchmarkCategoryRow = typeof resumeBenchmarkCategories.$inferSelect;

export async function listBenchmarkCategories(db: DB): Promise<BenchmarkCategoryRow[]> {
  return db.select().from(resumeBenchmarkCategories).orderBy(asc(resumeBenchmarkCategories.createdAt), asc(resumeBenchmarkCategories.id));
}

export async function upsertBenchmarkCategory(
  db: DB,
  c: { id: string; label: string; titleKeywords: string[]; excludeKeywords?: string[] },
): Promise<BenchmarkCategoryRow> {
  const values = { id: c.id, label: c.label, titleKeywords: c.titleKeywords, excludeKeywords: c.excludeKeywords ?? [] };
  const [row] = await db
    .insert(resumeBenchmarkCategories)
    .values(values)
    .onConflictDoUpdate({ target: resumeBenchmarkCategories.id, set: values })
    .returning();
  return row!;
}

/** Insert only the categories that don't exist yet (so user edits survive). */
export async function ensureBenchmarkCategories(
  db: DB,
  defaults: Array<{ id: string; label: string; titleKeywords: string[]; excludeKeywords?: string[] }>,
): Promise<void> {
  if (!defaults.length) return;
  await db
    .insert(resumeBenchmarkCategories)
    .values(defaults.map((c) => ({ ...c, excludeKeywords: c.excludeKeywords ?? [] })))
    .onConflictDoNothing();
}

export async function deleteBenchmarkCategory(db: DB, id: string): Promise<void> {
  await db.delete(resumeBenchmarkCategories).where(eq(resumeBenchmarkCategories.id, id));
}

export interface BenchmarkJobRow {
  categoryId: string;
  jobId: string;
  pinned: boolean;
  title: string;
  companyId: string;
  descriptionMd: string | null;
  closedAt: Date | null;
}

export async function listBenchmarkJobs(db: DB, categoryId?: string): Promise<BenchmarkJobRow[]> {
  return db
    .select({
      categoryId: resumeBenchmarkJobs.categoryId,
      jobId: resumeBenchmarkJobs.jobId,
      pinned: resumeBenchmarkJobs.pinned,
      title: jobs.title,
      companyId: jobs.companyId,
      descriptionMd: jobs.descriptionMd,
      closedAt: jobs.closedAt,
    })
    .from(resumeBenchmarkJobs)
    .innerJoin(jobs, eq(jobs.id, resumeBenchmarkJobs.jobId))
    .where(categoryId ? eq(resumeBenchmarkJobs.categoryId, categoryId) : sql`true`)
    .orderBy(asc(resumeBenchmarkJobs.categoryId), asc(resumeBenchmarkJobs.createdAt));
}

export async function addBenchmarkJob(db: DB, r: { categoryId: string; jobId: string; pinned: boolean }): Promise<void> {
  await db
    .insert(resumeBenchmarkJobs)
    .values(r)
    .onConflictDoUpdate({ target: [resumeBenchmarkJobs.categoryId, resumeBenchmarkJobs.jobId], set: { pinned: r.pinned } });
}

export async function removeBenchmarkJob(db: DB, categoryId: string, jobId: string): Promise<void> {
  await db.delete(resumeBenchmarkJobs).where(and(eq(resumeBenchmarkJobs.categoryId, categoryId), eq(resumeBenchmarkJobs.jobId, jobId)));
}

/** Drop a category's auto-picked (unpinned) JDs before a re-pick. */
export async function clearAutoBenchmarkJobs(db: DB, categoryId: string): Promise<void> {
  await db
    .delete(resumeBenchmarkJobs)
    .where(and(eq(resumeBenchmarkJobs.categoryId, categoryId), eq(resumeBenchmarkJobs.pinned, false)));
}

export type BenchmarkScoreRow = typeof resumeBenchmarkScores.$inferSelect;

export async function upsertBenchmarkScore(db: DB, r: { variantId: string; jobId: string; scores: unknown }): Promise<void> {
  const values = { ...r, computedAt: new Date() };
  await db
    .insert(resumeBenchmarkScores)
    .values(values)
    .onConflictDoUpdate({ target: [resumeBenchmarkScores.variantId, resumeBenchmarkScores.jobId], set: values });
}

export async function listBenchmarkScores(db: DB, variantIds?: string[]): Promise<BenchmarkScoreRow[]> {
  if (variantIds && !variantIds.length) return [];
  return db
    .select()
    .from(resumeBenchmarkScores)
    .where(variantIds ? inArray(resumeBenchmarkScores.variantId, variantIds) : sql`true`);
}

/** The ATS behind a job's most recently seen posting (company_sources.ats), or null. */
export async function atsTypeForJob(db: DB, jobId: string): Promise<string | null> {
  const rows = await db.execute<{ ats: string }>(sql`
    select s.ats_type as ats from raw_postings r join company_sources s on s.id = r.company_source_id
    where r.canonical_job_id = ${jobId}
    order by r.last_seen_at desc limit 1`);
  return rows[0]?.ats ?? null;
}

/**
 * Open jobs whose title has one of `titleKeywords` and none of `excludeKeywords`,
 * with a real description, best match score first (then newest).
 */
export async function findBenchmarkCandidates(
  db: DB,
  f: { titleKeywords: string[]; excludeKeywords: string[]; profileVersion: string | null; limit: number; excludeJobIds: string[] },
): Promise<Array<{ jobId: string; title: string; score: number | null }>> {
  if (!f.titleKeywords.length || f.limit <= 0) return [];
  const like = (k: string) => `%${k.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const include = sql.join(
    f.titleKeywords.map((k) => sql`lower(j.title) like ${like(k)}`),
    sql` or `,
  );
  const exclude = f.excludeKeywords.length
    ? sql`and not (${sql.join(
        f.excludeKeywords.map((k) => sql`lower(j.title) like ${like(k)}`),
        sql` or `,
      )})`
    : sql``;
  const notIn = f.excludeJobIds.length ? sql`and j.id not in (${sql.join(f.excludeJobIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  const rows = await db.execute<{ id: string; title: string; score: number | null }>(sql`
    select j.id, j.title, m.score
    from jobs j
    left join match_results m on m.job_id = j.id and m.profile_version = ${f.profileVersion ?? ''}
    where j.closed_at is null and length(coalesce(j.description_md, '')) >= 400
      and (${include}) ${exclude} ${notIn}
    order by m.score desc nulls last, j.posted_at desc nulls last, j.first_seen_at desc
    limit ${f.limit}`);
  return rows.map((r) => ({ jobId: r.id, title: r.title, score: r.score }));
}

/** A sample of open job descriptions: the corpus for TF-IDF keyword phrases. */
export async function sampleJobDescriptions(db: DB, limit = 1500): Promise<string[]> {
  const rows = await db.execute<{ d: string }>(sql`
    select description_md as d from jobs
    where closed_at is null and description_md is not null
    order by first_seen_at desc limit ${limit}`);
  return rows.map((r) => r.d);
}

/** The job's stored embedding (null until `jf embed` has run on it). */
export async function getJobEmbedding(db: DB, jobId: string): Promise<number[] | null> {
  const [r] = await db.select({ e: jobs.embedding }).from(jobs).where(eq(jobs.id, jobId));
  return r?.e ?? null;
}
