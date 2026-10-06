import { and, asc, desc, eq, ilike, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { DB } from './client.js';
import { companies, companySources, events, jobs, pluginRuns, rawPostings } from './schema.js';

export type AtsType = (typeof companySources.atsType.enumValues)[number];
export const ATS_TYPES = companySources.atsType.enumValues;

// ---------------------------------------------------------------------------
// companies / company_sources
// ---------------------------------------------------------------------------

export interface CompanyInput {
  name: string;
  domain?: string | null | undefined;
  tags?: string[] | undefined;
  location?: string | null | undefined;
  notes?: string | null | undefined;
}

/** Insert or update by unique name. Empty incoming fields never overwrite existing values. */
export async function upsertCompany(db: DB, c: CompanyInput): Promise<{ id: string; created: boolean }> {
  const [row] = await db
    .insert(companies)
    .values({
      name: c.name,
      domain: c.domain ?? null,
      tags: c.tags ?? [],
      location: c.location ?? null,
      notes: c.notes ?? null,
    })
    .onConflictDoUpdate({
      target: companies.name,
      set: {
        domain: sql`coalesce(excluded.domain, ${companies.domain})`,
        location: sql`coalesce(excluded.location, ${companies.location})`,
        notes: sql`coalesce(excluded.notes, ${companies.notes})`,
        tags: sql`case when cardinality(excluded.tags) > 0 then excluded.tags else ${companies.tags} end`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: companies.id, created: sql<boolean>`(xmax = 0)` });
  return row!;
}

export async function upsertCompanySource(
  db: DB,
  s: { companyId: string; atsType: AtsType; boardToken: string },
): Promise<{ id: string; created: boolean }> {
  const [inserted] = await db
    .insert(companySources)
    .values(s)
    .onConflictDoNothing()
    .returning({ id: companySources.id });
  if (inserted) return { id: inserted.id, created: true };
  const [existing] = await db
    .select({ id: companySources.id })
    .from(companySources)
    .where(
      and(
        eq(companySources.companyId, s.companyId),
        eq(companySources.atsType, s.atsType),
        eq(companySources.boardToken, s.boardToken),
      ),
    );
  return { id: existing!.id, created: false };
}

export interface SourceTargetRow {
  companySourceId: string;
  companyId: string;
  companyName: string;
  atsType: AtsType;
  boardToken: string;
  status: 'active' | 'paused' | 'error';
}

export async function listSourceTargets(
  db: DB,
  filter: { atsTypes?: AtsType[]; companyName?: string; includePaused?: boolean; ids?: string[] } = {},
): Promise<SourceTargetRow[]> {
  const conds: SQL[] = [sql`${companySources.boardToken} is not null`];
  if (filter.atsTypes?.length) conds.push(inArray(companySources.atsType, filter.atsTypes));
  if (filter.companyName) conds.push(ilike(companies.name, filter.companyName));
  if (!filter.includePaused) conds.push(ne(companySources.status, 'paused'));
  if (filter.ids?.length) conds.push(inArray(companySources.id, filter.ids));
  const rows = await db
    .select({
      companySourceId: companySources.id,
      companyId: companies.id,
      companyName: companies.name,
      atsType: companySources.atsType,
      boardToken: companySources.boardToken,
      status: companySources.status,
    })
    .from(companySources)
    .innerJoin(companies, eq(companies.id, companySources.companyId))
    .where(and(...conds))
    .orderBy(asc(companies.name));
  return rows.map((r) => ({ ...r, boardToken: r.boardToken! }));
}

export async function markSourceResult(db: DB, companySourceId: string, error: string | null): Promise<void> {
  await db
    .update(companySources)
    .set(
      error === null
        ? { status: 'active', lastError: null, lastFetchedAt: new Date() }
        : { status: 'error', lastError: error.slice(0, 2000) },
    )
    .where(eq(companySources.id, companySourceId));
}

// ---------------------------------------------------------------------------
// raw_postings / jobs (normalize + dedup write path)
// ---------------------------------------------------------------------------

export interface CanonicalJobInput {
  companyId: string;
  title: string;
  normalizedTitle: string;
  locations: string[];
  remotePolicy: string | null;
  seniority: string | null;
  descriptionMd: string | null;
  applyUrl: string | null;
  postedAt: Date | null;
  fingerprint: string;
}

export interface RawPostingInput {
  sourcePlugin: string;
  companySourceId: string | null;
  externalId: string;
  url: string | null;
  payload: unknown;
}

/**
 * Upsert the canonical job by fingerprint, then upsert the raw posting by
 * (source_plugin, external_id) and link it. One transaction, safe to repeat.
 */
export async function recordPosting(
  db: DB,
  job: CanonicalJobInput,
  raw: RawPostingInput,
  seenAt: Date,
): Promise<{ jobId: string; jobCreated: boolean; postingCreated: boolean }> {
  return db.transaction(async (tx) => {
    const [j] = await tx
      .insert(jobs)
      .values({ ...job, firstSeenAt: seenAt, lastSeenAt: seenAt })
      .onConflictDoUpdate({
        target: jobs.fingerprint,
        set: {
          lastSeenAt: seenAt,
          closedAt: null,
          // A changed description invalidates the embedding; the embed step recomputes it.
          embedding: sql`case when excluded.description_md is not null
            and excluded.description_md is distinct from ${jobs.descriptionMd} then null else ${jobs.embedding} end`,
          descriptionMd: sql`coalesce(excluded.description_md, ${jobs.descriptionMd})`,
          applyUrl: sql`coalesce(${jobs.applyUrl}, excluded.apply_url)`,
          remotePolicy: sql`coalesce(${jobs.remotePolicy}, excluded.remote_policy)`,
          seniority: sql`coalesce(${jobs.seniority}, excluded.seniority)`,
          postedAt: sql`least(${jobs.postedAt}, excluded.posted_at)`,
        },
      })
      .returning({ id: jobs.id, created: sql<boolean>`(xmax = 0)` });

    const [p] = await tx
      .insert(rawPostings)
      .values({
        ...raw,
        payload: raw.payload ?? {},
        fingerprint: job.fingerprint,
        canonicalJobId: j!.id,
        fetchedAt: seenAt,
        lastSeenAt: seenAt,
      })
      .onConflictDoUpdate({
        target: [rawPostings.sourcePlugin, rawPostings.externalId],
        set: {
          url: sql`excluded.url`,
          payload: sql`excluded.payload`,
          fingerprint: sql`excluded.fingerprint`,
          canonicalJobId: sql`excluded.canonical_job_id`,
          companySourceId: sql`excluded.company_source_id`,
          lastSeenAt: seenAt,
        },
      })
      .returning({ created: sql<boolean>`(xmax = 0)` });

    return { jobId: j!.id, jobCreated: j!.created, postingCreated: p!.created };
  });
}

/**
 * After a complete, successful fetch of one board: close this company's open
 * jobs that have no posting seen in this run and no posting from any other source.
 */
export async function closeStaleJobs(
  db: DB,
  companyId: string,
  companySourceId: string,
  runStartedAt: Date,
): Promise<number> {
  const closed = await db
    .update(jobs)
    .set({ closedAt: new Date() })
    .where(
      and(
        eq(jobs.companyId, companyId),
        isNull(jobs.closedAt),
        sql`not exists (
          select 1 from ${rawPostings} r
          where r.canonical_job_id = ${jobs.id}
            and (r.company_source_id is distinct from ${companySourceId}::uuid
                 or r.last_seen_at >= ${runStartedAt.toISOString()}::timestamptz)
        )`,
      ),
    )
    .returning({ id: jobs.id });
  return closed.length;
}

export interface JobListRow {
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
  sources: number;
}

export async function listJobs(
  db: DB,
  f: { company?: string; q?: string; includeClosed?: boolean; limit?: number } = {},
): Promise<JobListRow[]> {
  const conds: SQL[] = [];
  if (!f.includeClosed) conds.push(isNull(jobs.closedAt));
  if (f.company) conds.push(ilike(companies.name, `%${f.company}%`));
  if (f.q) conds.push(ilike(jobs.title, `%${f.q}%`));
  return db
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
      sources: sql<number>`(select count(*)::int from ${rawPostings} r where r.canonical_job_id = ${jobs.id})`,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(jobs.postedAt), asc(companies.name), asc(jobs.title))
    .limit(f.limit ?? 50);
}

export async function countJobs(db: DB): Promise<{ open: number; closed: number; rawPostings: number }> {
  const [r] = await db.execute<{ open: number; closed: number; raw: number }>(sql`
    select
      (select count(*)::int from ${jobs} where closed_at is null) as open,
      (select count(*)::int from ${jobs} where closed_at is not null) as closed,
      (select count(*)::int from ${rawPostings}) as raw`);
  return { open: r!.open, closed: r!.closed, rawPostings: r!.raw };
}

// ---------------------------------------------------------------------------
// plugin_runs / events
// ---------------------------------------------------------------------------

export async function startPluginRun(
  db: DB,
  r: { pluginId: string; stage: string; targetKey: string | null },
): Promise<string> {
  const [row] = await db
    .insert(pluginRuns)
    .values({ ...r, status: 'started' })
    .returning({ id: pluginRuns.id });
  return row!.id;
}

export async function finishPluginRun(
  db: DB,
  id: string,
  r: { status: 'succeeded' | 'failed'; itemsIn: number; itemsOut: number; error?: string; meta?: unknown },
): Promise<void> {
  await db
    .update(pluginRuns)
    .set({
      status: r.status,
      finishedAt: new Date(),
      itemsIn: r.itemsIn,
      itemsOut: r.itemsOut,
      error: r.error?.slice(0, 4000) ?? null,
      meta: r.meta ?? null,
    })
    .where(eq(pluginRuns.id, id));
}

/** Append-only audit log. Callers must never put secrets in the payload. */
export async function appendEvent(
  db: DB,
  e: { kind: string; subjectType?: string; subjectId?: string; payload?: unknown },
): Promise<void> {
  await db.insert(events).values({
    kind: e.kind,
    subjectType: e.subjectType ?? null,
    subjectId: e.subjectId ?? null,
    payload: e.payload ?? null,
  });
}

const PREFIX_TABLES = { jobs, contacts: sql`contacts`, review_items: sql`review_items`, companies } as const;

/**
 * Resolve a full id or a unique id prefix (as printed by the CLI) to the full
 * uuid. Throws when nothing or more than one row matches.
 */
export async function resolveIdPrefix(db: DB, table: keyof typeof PREFIX_TABLES, prefix: string): Promise<string> {
  const p = prefix.trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(p)) throw new Error(`"${prefix}" is not an id or id prefix`);
  const rows = await db.execute<{ id: string }>(
    sql`select id::text as id from ${PREFIX_TABLES[table]} where id::text like ${`${p}%`} limit 2`,
  );
  if (!rows.length) throw new Error(`no ${table.replace(/s$/, '').replace('_', ' ')} with id ${prefix}`);
  if (rows.length > 1) throw new Error(`id prefix ${prefix} is ambiguous; use more characters`);
  return rows[0]!.id;
}
