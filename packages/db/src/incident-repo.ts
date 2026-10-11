import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DB } from './client.js';
import { incidents } from './schema.js';

// Phase 22: orchestrator incidents.

export type IncidentRow = typeof incidents.$inferSelect;
export type IncidentStatus = 'open' | 'acting' | 'verifying' | 'resolved' | 'escalated';
export const UNRESOLVED: IncidentStatus[] = ['open', 'acting', 'verifying', 'escalated'];

export interface IncidentLogEntry {
  at: string;
  kind: string;
  [key: string]: unknown;
}

export interface IncidentFindingInput {
  checkId: string;
  fingerprint: string;
  severity: string;
  summary: string;
  data: Record<string, unknown>;
  evidenceAt: Date | null;
}

/** The unresolved incident for this fingerprint, refreshed with the finding — or a new one. */
export async function upsertIncident(db: DB, f: IncidentFindingInput, now = new Date()): Promise<{ incident: IncidentRow; created: boolean }> {
  const [open] = await db.select().from(incidents).where(and(eq(incidents.fingerprint, f.fingerprint), ne(incidents.status, 'resolved')));
  if (open) {
    const [row] = await db
      .update(incidents)
      .set({ severity: f.severity, summary: f.summary, data: f.data, evidenceAt: f.evidenceAt, updatedAt: now })
      .where(eq(incidents.id, open.id))
      .returning();
    return { incident: row!, created: false };
  }
  const [row] = await db
    .insert(incidents)
    .values({ checkId: f.checkId, fingerprint: f.fingerprint, severity: f.severity, summary: f.summary, data: f.data, evidenceAt: f.evidenceAt, openedAt: now, updatedAt: now })
    .returning();
  return { incident: row!, created: true };
}

export async function updateIncident(
  db: DB,
  id: string,
  patch: Partial<Pick<IncidentRow, 'status' | 'expert' | 'diagnosis' | 'attempts' | 'actedAt' | 'verifyUntil' | 'resolvedAt'>> & { addCostUsd?: number; log?: IncidentLogEntry[] },
  now = new Date(),
): Promise<IncidentRow | null> {
  const { addCostUsd, log, ...rest } = patch;
  const [row] = await db
    .update(incidents)
    .set({
      ...rest,
      updatedAt: now,
      ...(addCostUsd ? { llmCostUsd: sql`${incidents.llmCostUsd} + ${addCostUsd}` } : {}),
      ...(log?.length ? { log: sql`${incidents.log} || ${JSON.stringify(log)}::jsonb` } : {}),
    })
    .where(eq(incidents.id, id))
    .returning();
  return row ?? null;
}

export async function getIncident(db: DB, id: string): Promise<IncidentRow | null> {
  const [r] = await db.select().from(incidents).where(eq(incidents.id, id));
  return r ?? null;
}

export async function listIncidents(db: DB, o: { status?: IncidentStatus[]; limit?: number } = {}): Promise<IncidentRow[]> {
  return db
    .select()
    .from(incidents)
    .where(o.status?.length ? inArray(incidents.status, o.status) : undefined)
    .orderBy(desc(incidents.updatedAt))
    .limit(o.limit ?? 100);
}

/** Code fixes merged since `since` (the daily quota). */
export async function countCodeFixesSince(db: DB, since: Date): Promise<number> {
  const [r] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from incidents, jsonb_array_elements(log) e
    where e->>'kind' = 'code_fix' and (e->>'at')::timestamptz >= ${since.toISOString()}::timestamptz`);
  return r?.n ?? 0;
}
