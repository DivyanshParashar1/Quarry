import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { DB } from './client.js';
import { companies, jobs, matchResults, rawPostings } from './schema.js';

// ---------------------------------------------------------------------------
// Job embeddings
// ---------------------------------------------------------------------------

export interface JobForEmbedding {
  id: string;
  company: string;
  title: string;
  locations: string[];
  descriptionMd: string | null;
}

/** Open jobs that have no embedding yet (new, or description changed). */
export async function jobsNeedingEmbedding(db: DB, limit = 500): Promise<JobForEmbedding[]> {
  return db
    .select({
      id: jobs.id,
      company: companies.name,
      title: jobs.title,
      locations: jobs.locations,
      descriptionMd: jobs.descriptionMd,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(and(isNull(jobs.embedding), isNull(jobs.closedAt)))
    .orderBy(asc(jobs.firstSeenAt), asc(jobs.id))
    .limit(limit);
}

export async function countJobsNeedingEmbedding(db: DB): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(isNull(jobs.embedding), isNull(jobs.closedAt)));
  return r!.n;
}

export async function setJobEmbeddings(db: DB, rows: { id: string; embedding: number[] }[]): Promise<void> {
  if (!rows.length) return;
  await db.transaction(async (tx) => {
    for (const r of rows) await tx.update(jobs).set({ embedding: r.embedding }).where(eq(jobs.id, r.id));
  });
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface JobForMatch {
  id: string;
  companyId: string;
  company: string;
  title: string;
  normalizedTitle: string;
  locations: string[];
  remotePolicy: 'remote' | 'hybrid' | 'onsite' | null;
  seniority: string | null;
  descriptionMd: string | null;
  applyUrl: string | null;
  postedAt: Date | null;
  embedding: number[] | null;
}

/** Open jobs with no match result for this profile version (or all open jobs when rescoring). */
export async function jobsToMatch(
  db: DB,
  profileVersion: string,
  opts: { rescore?: boolean; limit?: number; jobIds?: string[] } = {},
): Promise<JobForMatch[]> {
  const conds: SQL[] = [isNull(jobs.closedAt)];
  if (!opts.rescore) {
    conds.push(
      sql`not exists (select 1 from ${matchResults} m where m.job_id = ${jobs.id} and m.profile_version = ${profileVersion})`,
    );
  }
  if (opts.jobIds?.length) conds.push(inArray(jobs.id, opts.jobIds));
  const q = db
    .select({
      id: jobs.id,
      companyId: jobs.companyId,
      company: companies.name,
      title: jobs.title,
      normalizedTitle: jobs.normalizedTitle,
      locations: jobs.locations,
      remotePolicy: jobs.remotePolicy,
      seniority: jobs.seniority,
      descriptionMd: jobs.descriptionMd,
      applyUrl: jobs.applyUrl,
      postedAt: jobs.postedAt,
      embedding: jobs.embedding,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(and(...conds))
    .orderBy(asc(jobs.id));
  const rows = opts.limit ? await q.limit(opts.limit) : await q;
  return rows.map((r) => ({ ...r, remotePolicy: r.remotePolicy as JobForMatch['remotePolicy'] }));
}

export interface MatchResultInput {
  jobId: string;
  method: 'filtered' | 'prefilter' | 'llm';
  score: number;
  similarity: number | null;
  rubric: Record<string, unknown>;
  reasons: string;
  provider: string | null;
  model: string | null;
  confidence: number | null;
}

/** Upsert by (job, profile version): rescoring replaces the previous result. */
export async function saveMatchResults(
  db: DB,
  profileVersion: string,
  pluginId: string,
  results: MatchResultInput[],
): Promise<void> {
  for (let i = 0; i < results.length; i += 500) {
    const chunk = results.slice(i, i + 500);
    await db
      .insert(matchResults)
      .values(chunk.map((r) => ({ ...r, profileVersion, pluginId, score: Math.round(r.score) })))
      .onConflictDoUpdate({
        target: [matchResults.jobId, matchResults.profileVersion],
        set: {
          pluginId: sql`excluded.plugin_id`,
          method: sql`excluded.method`,
          score: sql`excluded.score`,
          similarity: sql`excluded.similarity`,
          rubric: sql`excluded.rubric`,
          reasons: sql`excluded.reasons`,
          provider: sql`excluded.provider`,
          model: sql`excluded.model`,
          confidence: sql`excluded.confidence`,
          createdAt: sql`now()`,
        },
      });
  }
}

// ---------------------------------------------------------------------------
// Dashboard queries
// ---------------------------------------------------------------------------

export type MatchMethod = 'filtered' | 'prefilter' | 'llm';

export interface RankedJobFilter {
  profileVersion: string | null;
  q?: string;
  company?: string;
  location?: string;
  remotePolicy?: ('remote' | 'hybrid' | 'onsite')[];
  seniority?: string[];
  methods?: (MatchMethod | 'unscored')[];
  minScore?: number;
  includeClosed?: boolean;
  sort?: 'score' | 'posted';
  limit?: number;
  offset?: number;
}

export interface RankedJobRow {
  id: string;
  company: string;
  title: string;
  locations: string[];
  remotePolicy: string | null;
  seniority: string | null;
  applyUrl: string | null;
  postedAt: Date | null;
  firstSeenAt: Date;
  closedAt: Date | null;
  score: number | null;
  method: MatchMethod | null;
  similarity: number | null;
  reasons: string | null;
  /** Phase 10 */
  inferredDeadline: string | null;
  deadlineConfidence: number | null;
}

export async function listRankedJobs(db: DB, f: RankedJobFilter): Promise<{ rows: RankedJobRow[]; total: number }> {
  const version = f.profileVersion ?? '';
  const conds: SQL[] = [];
  if (!f.includeClosed) conds.push(isNull(jobs.closedAt));
  if (f.q) conds.push(ilike(jobs.title, `%${escapeLike(f.q)}%`));
  if (f.company) conds.push(ilike(companies.name, `%${escapeLike(f.company)}%`));
  if (f.location) {
    conds.push(sql`exists (select 1 from unnest(${jobs.locations}) l where l ilike ${`%${escapeLike(f.location)}%`})`);
  }
  if (f.remotePolicy?.length) conds.push(inArray(jobs.remotePolicy, f.remotePolicy));
  if (f.seniority?.length) {
    const levels = f.seniority.filter((s) => s !== 'mid');
    const parts: SQL[] = [];
    if (levels.length) parts.push(inArray(jobs.seniority, levels));
    if (f.seniority.includes('mid')) parts.push(isNull(jobs.seniority));
    conds.push(sql`(${sql.join(parts, sql` or `)})`);
  }
  if (f.methods?.length) {
    const methods = f.methods.filter((m): m is MatchMethod => m !== 'unscored');
    const parts: SQL[] = [];
    if (methods.length) parts.push(inArray(matchResults.method, methods));
    if (f.methods.includes('unscored')) parts.push(isNull(matchResults.id));
    conds.push(sql`(${sql.join(parts, sql` or `)})`);
  }
  if (f.minScore !== undefined) conds.push(sql`${matchResults.score} >= ${f.minScore}`);
  const where = conds.length ? and(...conds) : undefined;

  const base = db
    .select({
      id: jobs.id,
      company: companies.name,
      title: jobs.title,
      locations: jobs.locations,
      remotePolicy: jobs.remotePolicy,
      seniority: jobs.seniority,
      applyUrl: jobs.applyUrl,
      postedAt: jobs.postedAt,
      firstSeenAt: jobs.firstSeenAt,
      closedAt: jobs.closedAt,
      score: matchResults.score,
      method: matchResults.method,
      similarity: matchResults.similarity,
      reasons: matchResults.reasons,
      inferredDeadline: jobs.inferredDeadline,
      deadlineConfidence: jobs.deadlineConfidence,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(matchResults, and(eq(matchResults.jobId, jobs.id), eq(matchResults.profileVersion, version)))
    .where(where);

  const order =
    f.sort === 'posted'
      ? [sql`${jobs.postedAt} desc nulls last`, asc(jobs.id)]
      : [
          sql`${matchResults.score} desc nulls last`,
          sql`${matchResults.similarity} desc nulls last`,
          sql`${jobs.postedAt} desc nulls last`,
          asc(jobs.id),
        ];
  const rows = await base
    .orderBy(...order)
    .limit(f.limit ?? 50)
    .offset(f.offset ?? 0);

  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(matchResults, and(eq(matchResults.jobId, jobs.id), eq(matchResults.profileVersion, version)))
    .where(where);
  return { rows, total: count!.n };
}

export interface JobDetail {
  id: string;
  company: { id: string; name: string; domain: string | null; tags: string[] };
  title: string;
  locations: string[];
  remotePolicy: string | null;
  seniority: string | null;
  descriptionMd: string | null;
  applyUrl: string | null;
  postedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  closedAt: Date | null;
  closedReason: string | null;
  /** Phase 10: inferred application deadline. */
  deadline: { date: string | null; confidence: number | null; rationale: string | null; sources: string[]; inferredAt: Date | null } | null;
  match: {
    profileVersion: string;
    method: MatchMethod;
    score: number;
    similarity: number | null;
    rubric: unknown;
    reasons: string;
    provider: string | null;
    model: string | null;
    confidence: number | null;
    createdAt: Date;
  } | null;
  sources: { sourcePlugin: string; externalId: string; url: string | null; lastSeenAt: Date }[];
}

export async function getJobDetail(db: DB, id: string, profileVersion: string | null): Promise<JobDetail | null> {
  const [j] = await db
    .select({ job: jobs, company: companies })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(jobs.id, id));
  if (!j) return null;
  const [m] = profileVersion
    ? await db
        .select()
        .from(matchResults)
        .where(and(eq(matchResults.jobId, id), eq(matchResults.profileVersion, profileVersion)))
    : [];
  const sources = await db
    .select({
      sourcePlugin: rawPostings.sourcePlugin,
      externalId: rawPostings.externalId,
      url: rawPostings.url,
      lastSeenAt: rawPostings.lastSeenAt,
    })
    .from(rawPostings)
    .where(eq(rawPostings.canonicalJobId, id))
    .orderBy(desc(rawPostings.lastSeenAt));
  const job = j.job;
  return {
    id: job.id,
    company: { id: j.company.id, name: j.company.name, domain: j.company.domain, tags: j.company.tags },
    title: job.title,
    locations: job.locations,
    remotePolicy: job.remotePolicy,
    seniority: job.seniority,
    descriptionMd: job.descriptionMd,
    applyUrl: job.applyUrl,
    postedAt: job.postedAt,
    firstSeenAt: job.firstSeenAt,
    lastSeenAt: job.lastSeenAt,
    closedAt: job.closedAt,
    closedReason: job.closedReason,
    deadline: job.deadlineInferredAt
      ? {
          date: job.inferredDeadline,
          confidence: job.deadlineConfidence,
          rationale: job.deadlineRationale,
          sources: (job.deadlineSources as string[] | null) ?? [],
          inferredAt: job.deadlineInferredAt,
        }
      : null,
    match: m
      ? {
          profileVersion: m.profileVersion,
          method: m.method,
          score: m.score,
          similarity: m.similarity,
          rubric: m.rubric,
          reasons: m.reasons,
          provider: m.provider,
          model: m.model,
          confidence: m.confidence,
          createdAt: m.createdAt,
        }
      : null,
    sources,
  };
}

export interface MatchStats {
  openJobs: number;
  embedded: number;
  scored: { llm: number; prefilter: number; filtered: number };
  unscored: number;
}

export async function matchStats(db: DB, profileVersion: string | null): Promise<MatchStats> {
  const [r] = await db.execute<{
    open: number;
    embedded: number;
    llm: number;
    prefilter: number;
    filtered: number;
  }>(sql`
    select
      count(*)::int as open,
      count(*) filter (where j.embedding is not null)::int as embedded,
      count(*) filter (where m.method = 'llm')::int as llm,
      count(*) filter (where m.method = 'prefilter')::int as prefilter,
      count(*) filter (where m.method = 'filtered')::int as filtered
    from ${jobs} j
    left join ${matchResults} m on m.job_id = j.id and m.profile_version = ${profileVersion ?? ''}
    where j.closed_at is null`);
  const scored = { llm: r!.llm, prefilter: r!.prefilter, filtered: r!.filtered };
  return { openJobs: r!.open, embedded: r!.embedded, scored, unscored: r!.open - scored.llm - scored.prefilter - scored.filtered };
}

export async function listCompanyNames(db: DB): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: companies.name })
    .from(companies)
    .innerJoin(jobs, and(eq(jobs.companyId, companies.id), isNull(jobs.closedAt), isNotNull(jobs.id)))
    .orderBy(asc(companies.name));
  return rows.map((r) => r.name);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
