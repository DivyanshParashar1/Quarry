import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { DB } from './client.js';
import { companies, contacts, outreachThreads, sentEmails } from './schema.js';

// Phase 24: the sent-mail log. Written by the core on every send outcome.

export type SentEmailRow = typeof sentEmails.$inferSelect;
export type SentEmailStatus = SentEmailRow['status'];
export type NewSentEmail = typeof sentEmails.$inferInsert;

export interface SentEmailAttachment {
  filename: string;
  contentType: string;
  size?: number;
  sha256?: string;
  /** The kept copy on disk. */
  path?: string;
}

/** Insert, or replace the row for the same review item (a scheduled mail that was later sent). */
export async function recordSentEmail(db: DB, r: NewSentEmail): Promise<SentEmailRow> {
  if (!r.reviewItemId) {
    const [row] = await db.insert(sentEmails).values(r).returning();
    return row!;
  }
  // Only the fields given: a later outcome must not wipe the compose input saved when it was queued.
  const set = Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== undefined && k !== 'reviewItemId' && k !== 'createdAt'));
  const [row] = await db
    .insert(sentEmails)
    .values(r)
    .onConflictDoUpdate({ target: sentEmails.reviewItemId, set: { ...set, updatedAt: new Date() } })
    .returning();
  return row!;
}

export async function updateSentEmail(
  db: DB,
  id: string,
  patch: Partial<Pick<SentEmailRow, 'status' | 'gmailId' | 'gmailThreadId' | 'gmailDraftId' | 'threadId' | 'sentAt' | 'error' | 'contactId' | 'companyId'>>,
): Promise<SentEmailRow | null> {
  const [row] = await db.update(sentEmails).set({ ...patch, updatedAt: new Date() }).where(eq(sentEmails.id, id)).returning();
  return row ?? null;
}

export async function getSentEmail(db: DB, id: string): Promise<SentEmailListRow | null> {
  const [r] = await listSentEmails(db, { ids: [id], limit: 1 });
  return r ?? null;
}

export async function sentEmailForReviewItem(db: DB, reviewItemId: string): Promise<SentEmailRow | null> {
  const [r] = await db.select().from(sentEmails).where(eq(sentEmails.reviewItemId, reviewItemId));
  return r ?? null;
}

export interface SentEmailListRow extends SentEmailRow {
  contactName: string | null;
  companyName: string | null;
  /** From the outreach thread, when there is one: sent | replied | bounced | closed. */
  threadState: string | null;
  repliedAt: Date | null;
}

export async function listSentEmails(
  db: DB,
  f: { status?: SentEmailStatus[]; source?: string[]; q?: string; ids?: string[]; limit?: number; offset?: number } = {},
): Promise<SentEmailListRow[]> {
  const conds: SQL[] = [];
  if (f.status?.length) conds.push(inArray(sentEmails.status, f.status));
  if (f.source?.length) conds.push(inArray(sentEmails.source, f.source));
  if (f.ids?.length) conds.push(inArray(sentEmails.id, f.ids));
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(sentEmails.toAddress, like), ilike(sentEmails.toName, like), ilike(sentEmails.subject, like), ilike(sentEmails.body, like))!);
  }
  const rows = await db
    .select({
      s: sentEmails,
      contactName: contacts.name,
      companyName: companies.name,
      threadState: outreachThreads.state,
      repliedAt: outreachThreads.repliedAt,
    })
    .from(sentEmails)
    .leftJoin(contacts, eq(contacts.id, sentEmails.contactId))
    .leftJoin(companies, eq(companies.id, sentEmails.companyId))
    .leftJoin(outreachThreads, eq(outreachThreads.id, sentEmails.threadId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(sql`coalesce(${sentEmails.sentAt}, ${sentEmails.scheduledFor}, ${sentEmails.createdAt})`))
    .limit(f.limit ?? 100)
    .offset(f.offset ?? 0);
  return rows.map(({ s, ...rest }) => ({ ...s, ...rest }));
}

export async function sentEmailCounts(db: DB): Promise<Record<SentEmailStatus, number>> {
  const rows = await db.select({ status: sentEmails.status, n: sql<number>`count(*)::int` }).from(sentEmails).groupBy(sentEmails.status);
  const out = { queued: 0, sent: 0, dry_run: 0, scheduled: 0, cancelled: 0, failed: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/** The most recently used contact with this address (case-insensitive). */
export async function findContactByEmail(db: DB, email: string): Promise<typeof contacts.$inferSelect | null> {
  const [r] = await db
    .select()
    .from(contacts)
    .where(sql`lower(${contacts.email}) = lower(${email})`)
    .orderBy(desc(contacts.updatedAt))
    .limit(1);
  return r ?? null;
}
