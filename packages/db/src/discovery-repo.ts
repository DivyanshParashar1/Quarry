import { and, asc, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import type { DB } from './client.js';
import { companies, companySources } from './schema.js';
import type { AtsType } from './repos.js';

/** Lower-case, no scheme/path, no leading www. */
export function canonicalDomain(d: string | null | undefined): string | null {
  if (!d) return null;
  const t = d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return t || null;
}

export async function findCompanyByDomain(db: DB, domain: string): Promise<{ id: string; name: string } | null> {
  const d = canonicalDomain(domain);
  if (!d) return null;
  const [row] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(sql`regexp_replace(lower(${companies.domain}), '^(https?://)?(www\\.)?', '') = ${d}`)
    .limit(1);
  return row ?? null;
}

export interface DiscoveredSource {
  atsType: AtsType;
  boardToken: string;
}

export interface SaveDiscoveredInput {
  name: string;
  domain?: string | null;
  tags?: string[];
  location?: string | null;
  notes?: string | null;
  discoveredVia: string;
  sources: DiscoveredSource[];
}

export interface SaveDiscoveredResult {
  companyId: string;
  companyCreated: boolean;
  /** The company already existed under another name with the same domain. */
  matchedBy: 'domain' | 'name' | null;
  sourcesCreated: number;
}

/**
 * Write a discovered company and its detected boards in one transaction.
 * Dedupes by domain first (so "Walmart Global Tech India" and "Walmart Global
 * Tech" with the same domain stay one company), then by name. Never
 * overwrites fields a human set; only fills blanks.
 */
export async function saveDiscoveredCompany(db: DB, c: SaveDiscoveredInput): Promise<SaveDiscoveredResult> {
  const domain = canonicalDomain(c.domain);
  return db.transaction(async (tx) => {
    let existing: { id: string; tags: string[] } | undefined;
    let matchedBy: SaveDiscoveredResult['matchedBy'] = null;
    if (domain) {
      [existing] = await tx
        .select({ id: companies.id, tags: companies.tags })
        .from(companies)
        .where(sql`regexp_replace(lower(${companies.domain}), '^(https?://)?(www\\.)?', '') = ${domain}`)
        .limit(1);
      if (existing) matchedBy = 'domain';
    }
    if (!existing) {
      [existing] = await tx
        .select({ id: companies.id, tags: companies.tags })
        .from(companies)
        .where(sql`lower(${companies.name}) = ${c.name.trim().toLowerCase()}`)
        .limit(1);
      if (existing) matchedBy = 'name';
    }

    let companyId: string;
    let companyCreated = false;
    if (existing) {
      companyId = existing.id;
      await tx
        .update(companies)
        .set({
          domain: sql`coalesce(${companies.domain}, ${domain})`,
          location: sql`coalesce(${companies.location}, ${c.location ?? null})`,
          tags: [...new Set([...existing.tags, ...(c.tags ?? [])])],
          atsCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));
    } else {
      const [row] = await tx
        .insert(companies)
        .values({
          name: c.name.trim(),
          domain,
          tags: c.tags ?? [],
          location: c.location ?? null,
          notes: c.notes ?? null,
          discoveredVia: c.discoveredVia,
          discoveredAt: new Date(),
          atsCheckedAt: new Date(),
        })
        .returning({ id: companies.id });
      companyId = row!.id;
      companyCreated = true;
    }

    let sourcesCreated = 0;
    for (const s of c.sources) {
      const inserted = await tx
        .insert(companySources)
        .values({ companyId, atsType: s.atsType, boardToken: s.boardToken, detectedBy: 'discover_ats' })
        .onConflictDoNothing()
        .returning({ id: companySources.id });
      sourcesCreated += inserted.length;
    }
    return { companyId, companyCreated, matchedBy, sourcesCreated };
  });
}

export async function markAtsChecked(db: DB, companyId: string): Promise<void> {
  await db.update(companies).set({ atsCheckedAt: new Date() }).where(eq(companies.id, companyId));
}

export interface CompanyForAtsCheck {
  id: string;
  name: string;
  domain: string | null;
  atsCheckedAt: Date | null;
  sources: { id: string; atsType: AtsType; boardToken: string | null; status: string; lastFetchedAt: Date | null }[];
}

/**
 * Companies due an ATS (re)check: never checked, or last checked before
 * `checkedBefore`. `onlyWithoutSources` limits to companies with no active board.
 */
export async function listCompaniesForAtsCheck(
  db: DB,
  f: { checkedBefore: Date; onlyWithoutSources?: boolean; limit?: number },
): Promise<CompanyForAtsCheck[]> {
  const rows = await db
    .select({ id: companies.id, name: companies.name, domain: companies.domain, atsCheckedAt: companies.atsCheckedAt })
    .from(companies)
    .where(
      and(
        or(isNull(companies.atsCheckedAt), lt(companies.atsCheckedAt, f.checkedBefore)),
        f.onlyWithoutSources
          ? sql`not exists (select 1 from ${companySources} s where s.company_id = ${companies.id} and s.status <> 'paused')`
          : undefined,
        // Exclusions tagged by the user are never re-checked.
        sql`not ('excluded' = any(${companies.tags}))`,
      ),
    )
    .orderBy(sql`${companies.atsCheckedAt} asc nulls first`, asc(companies.name))
    .limit(f.limit ?? 50);
  if (!rows.length) return [];
  const srcs = await db
    .select({
      companyId: companySources.companyId,
      id: companySources.id,
      atsType: companySources.atsType,
      boardToken: companySources.boardToken,
      status: companySources.status,
      lastFetchedAt: companySources.lastFetchedAt,
    })
    .from(companySources)
    .where(sql`${companySources.companyId} in ${rows.map((r) => r.id)}`);
  return rows.map((r) => ({ ...r, sources: srcs.filter((s) => s.companyId === r.id) }));
}

/** Pause a board that discovery found to be stale (the company moved ATS). Never deletes. */
export async function markSourceStale(db: DB, companySourceId: string, reason: string): Promise<void> {
  await db
    .update(companySources)
    .set({ status: 'paused', lastError: `stale: ${reason}`.slice(0, 2000) })
    .where(eq(companySources.id, companySourceId));
}

export interface RecentCompanyRow {
  id: string;
  name: string;
  domain: string | null;
  tags: string[];
  discoveredVia: string | null;
  discoveredAt: Date | null;
  sources: { atsType: string; boardToken: string | null; status: string }[];
}

/** Companies discovered since `since` (newest first) for the /companies panel. */
export async function listRecentlyDiscovered(db: DB, since: Date, limit = 200): Promise<RecentCompanyRow[]> {
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      tags: companies.tags,
      discoveredVia: companies.discoveredVia,
      discoveredAt: companies.discoveredAt,
    })
    .from(companies)
    .where(and(gte(companies.discoveredAt, since), sql`${companies.discoveredVia} <> 'csv'`))
    .orderBy(desc(companies.discoveredAt))
    .limit(limit);
  if (!rows.length) return [];
  const srcs = await db
    .select({ companyId: companySources.companyId, atsType: companySources.atsType, boardToken: companySources.boardToken, status: companySources.status })
    .from(companySources)
    .where(sql`${companySources.companyId} in ${rows.map((r) => r.id)}`);
  return rows.map((r) => ({ ...r, sources: srcs.filter((s) => s.companyId === r.id).map(({ companyId: _c, ...s }) => s) }));
}

/** How many companies discovery added per day (for the drift banner). */
export async function discoveredCountSince(db: DB, since: Date): Promise<number> {
  const [r] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${companies} where discovered_at >= ${since.toISOString()}::timestamptz and discovered_via <> 'csv'`,
  );
  return r?.n ?? 0;
}
