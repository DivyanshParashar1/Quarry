import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DB } from './client.js';
import { actions, companies, contacts, jobReferralBatches, outreachThreads, reviewItems } from './schema.js';

export type ReferralBatchRow = typeof jobReferralBatches.$inferSelect;

/** First-contact kinds: what the per-contact cooldown counts. Follow-ups don't. */
export const FIRST_CONTACT_KINDS = ['outreach', 'referral_ask'] as const;

export async function getBatchForJob(db: DB, jobId: string): Promise<ReferralBatchRow | null> {
  const [r] = await db.select().from(jobReferralBatches).where(eq(jobReferralBatches.jobId, jobId));
  return r ?? null;
}

export async function getBatch(db: DB, id: string): Promise<ReferralBatchRow | null> {
  const [r] = await db.select().from(jobReferralBatches).where(eq(jobReferralBatches.id, id));
  return r ?? null;
}

/** One batch per job: returns the existing one (created=false) or a new one. */
export async function ensureBatch(db: DB, jobId: string, requestedCount: number): Promise<{ batch: ReferralBatchRow; created: boolean }> {
  const [inserted] = await db.insert(jobReferralBatches).values({ jobId, requestedCount }).onConflictDoNothing().returning();
  if (inserted) return { batch: inserted, created: true };
  return { batch: (await getBatchForJob(db, jobId))!, created: false };
}

export async function updateBatch(
  db: DB,
  id: string,
  patch: Partial<Pick<ReferralBatchRow, 'status' | 'requestedCount' | 'note' | 'firstSentAt' | 'repliedAt'>>,
): Promise<ReferralBatchRow | null> {
  const [r] = await db.update(jobReferralBatches).set({ ...patch, updatedAt: new Date() }).where(eq(jobReferralBatches.id, id)).returning();
  return r ?? null;
}

/** Recompute drafted/sent/replied counts from the batch's items and threads. */
export async function refreshBatchCounts(db: DB, id: string): Promise<ReferralBatchRow | null> {
  const [r] = await db
    .update(jobReferralBatches)
    .set({
      draftedCount: sql`(select count(*)::int from ${reviewItems} r where r.batch_id = ${id} and r.kind = 'referral_ask'
        and r.status not in ('rejected', 'cancelled'))`,
      sentCount: sql`(select count(*)::int from ${reviewItems} r where r.batch_id = ${id} and r.kind = 'referral_ask' and r.status = 'executed')`,
      repliedCount: sql`(select count(*)::int from ${outreachThreads} t join ${reviewItems} r on r.id = t.review_item_id
        where r.batch_id = ${id} and t.state = 'replied')`,
      updatedAt: new Date(),
    })
    .where(eq(jobReferralBatches.id, id))
    .returning();
  return r ?? null;
}

export interface BatchItemRow {
  id: string;
  status: string;
  pluginId: string;
  channel: 'email' | 'linkedin';
  contactId: string | null;
  contactName: string | null;
  contactRole: string | null;
  contactEmail: string | null;
  linkedinUrl: string | null;
  threadState: string | null;
  decidedBy: string | null;
  error: string | null;
  createdAt: Date;
}

export async function listBatchItems(db: DB, batchId: string): Promise<BatchItemRow[]> {
  const rows = await db
    .select({
      id: reviewItems.id,
      status: reviewItems.status,
      pluginId: reviewItems.pluginId,
      contactId: reviewItems.contactId,
      contactName: contacts.name,
      contactRole: contacts.role,
      contactEmail: contacts.email,
      linkedinUrl: contacts.linkedinUrl,
      threadState: outreachThreads.state,
      decidedBy: reviewItems.decidedBy,
      error: reviewItems.error,
      createdAt: reviewItems.createdAt,
    })
    .from(reviewItems)
    .leftJoin(contacts, eq(contacts.id, reviewItems.contactId))
    .leftJoin(outreachThreads, eq(outreachThreads.reviewItemId, reviewItems.id))
    .where(and(eq(reviewItems.batchId, batchId), eq(reviewItems.kind, 'referral_ask')))
    .orderBy(asc(reviewItems.createdAt));
  return rows.map((r) => ({ ...r, channel: r.pluginId.includes('linkedin') ? 'linkedin' : 'email' }));
}

/** An ask whose email bounced never reached the person: it doesn't count toward the cooldown or the job's cap. */
const notBounced = sql`not exists (select 1 from ${outreachThreads} where ${outreachThreads.reviewItemId} = ${reviewItems.id} and ${outreachThreads.state} = 'bounced')`;

/**
 * When a contact was last asked (first contact: outreach or referral ask),
 * counting items that are executed, approved (about to go) or pending —
 * so two fan-outs can't both queue the same person. `excludeItemId` skips the
 * item being checked.
 */
export async function lastAskedAt(db: DB, contactId: string, excludeItemId?: string): Promise<{ at: Date; jobId: string | null; status: string } | null> {
  const [r] = await db
    .select({
      at: sql<Date>`coalesce(${actions.executedAt}, ${reviewItems.decidedAt}, ${reviewItems.createdAt})`,
      jobId: reviewItems.jobId,
      status: reviewItems.status,
    })
    .from(reviewItems)
    .leftJoin(actions, and(eq(actions.reviewItemId, reviewItems.id), eq(actions.status, 'succeeded'), eq(actions.dryRun, false)))
    .where(
      and(
        eq(reviewItems.contactId, contactId),
        inArray(reviewItems.kind, [...FIRST_CONTACT_KINDS]),
        inArray(reviewItems.status, ['pending', 'approved', 'executed']),
        excludeItemId ? ne(reviewItems.id, excludeItemId) : undefined,
        notBounced,
      ),
    )
    .orderBy(desc(sql`coalesce(${actions.executedAt}, ${reviewItems.decidedAt}, ${reviewItems.createdAt})`))
    .limit(1);
  return r ? { at: new Date(r.at), jobId: r.jobId, status: r.status } : null;
}

/** Contacts asked (any status but rejected/cancelled/failed) since `since`, for cooldown filtering in bulk. */
export async function contactsAskedSince(db: DB, contactIds: string[], since: Date): Promise<Set<string>> {
  if (!contactIds.length) return new Set();
  const rows = await db
    .selectDistinct({ contactId: reviewItems.contactId })
    .from(reviewItems)
    .where(
      and(
        inArray(reviewItems.contactId, contactIds),
        inArray(reviewItems.kind, [...FIRST_CONTACT_KINDS]),
        inArray(reviewItems.status, ['pending', 'approved', 'executed']),
        // Parenthesised: drizzle's and() doesn't wrap raw SQL, and a bare `or` would escape the other filters.
        sql`(${reviewItems.createdAt} >= ${since.toISOString()}::timestamptz or ${reviewItems.status} in ('pending', 'approved'))`,
        notBounced,
      ),
    );
  return new Set(rows.map((r) => r.contactId).filter((x): x is string => !!x));
}

/** Referral asks for a job that are approved or already sent (what the per-job cap counts). */
export async function committedAsksForJob(db: DB, jobId: string, excludeItemId?: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.jobId, jobId),
        eq(reviewItems.kind, 'referral_ask'),
        inArray(reviewItems.status, ['approved', 'executed']),
        excludeItemId ? ne(reviewItems.id, excludeItemId) : undefined,
        notBounced,
      ),
    );
  return r!.n;
}

/**
 * A reply on one item of a batch: mark the batch replied and stop every other
 * thread of that batch from getting follow-ups (pending/approved follow-ups
 * are cancelled; next_followup_at is cleared). Other batches are untouched.
 */
export async function markBatchReplied(db: DB, batchId: string, at: Date): Promise<{ cancelledFollowups: number; first: boolean }> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select({ status: jobReferralBatches.status }).from(jobReferralBatches).where(eq(jobReferralBatches.id, batchId));
    await tx
      .update(jobReferralBatches)
      .set({ status: 'replied', repliedAt: sql`coalesce(${jobReferralBatches.repliedAt}, ${at.toISOString()}::timestamptz)`, updatedAt: new Date() })
      .where(eq(jobReferralBatches.id, batchId));
    const threadIds = (
      await tx
        .select({ id: outreachThreads.id })
        .from(outreachThreads)
        .innerJoin(reviewItems, eq(reviewItems.id, outreachThreads.reviewItemId))
        .where(eq(reviewItems.batchId, batchId))
    ).map((t) => t.id);
    let cancelled = 0;
    if (threadIds.length) {
      await tx.update(outreachThreads).set({ nextFollowupAt: null, updatedAt: new Date() }).where(inArray(outreachThreads.id, threadIds));
      const rows = await tx
        .update(reviewItems)
        .set({ status: 'cancelled', decisionNote: 'cancelled: batch replied', updatedAt: new Date() })
        .where(and(inArray(reviewItems.threadId, threadIds), eq(reviewItems.kind, 'followup'), inArray(reviewItems.status, ['pending', 'approved'])))
        .returning({ id: reviewItems.id });
      cancelled = rows.length;
    }
    return { cancelledFollowups: cancelled, first: !!before && before.status !== 'replied' };
  });
}

/** Batch id of the review item that opened a thread (null for non-referral threads). */
export async function batchIdForThread(db: DB, threadId: string): Promise<string | null> {
  const [r] = await db
    .select({ batchId: reviewItems.batchId })
    .from(outreachThreads)
    .innerJoin(reviewItems, eq(reviewItems.id, outreachThreads.reviewItemId))
    .where(eq(outreachThreads.id, threadId));
  return r?.batchId ?? null;
}

export async function setContactHints(
  db: DB,
  contactId: string,
  h: { roleHint?: string | null; seniorityHint?: string | null; department?: string | null; emailCandidates?: unknown[] },
): Promise<void> {
  await db
    .update(contacts)
    .set({
      ...(h.roleHint !== undefined ? { roleHint: h.roleHint } : {}),
      ...(h.seniorityHint !== undefined ? { seniorityHint: h.seniorityHint } : {}),
      ...(h.department !== undefined ? { department: h.department } : {}),
      ...(h.emailCandidates !== undefined ? { emailCandidates: h.emailCandidates } : {}),
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}

export async function setCompanyLinkedin(db: DB, companyId: string, l: { linkedinId: string | null; linkedinSlug: string | null }): Promise<void> {
  await db.update(companies).set({ ...l, updatedAt: new Date() }).where(eq(companies.id, companyId));
}

export interface LinkedInThreadRow {
  threadId: string;
  state: string;
  contactId: string;
  contactName: string;
  linkedinUrl: string | null;
  reviewItemId: string | null;
}

/** LinkedIn-channel threads (for matching tracker events by profile URL or name). */
export async function linkedinThreads(db: DB): Promise<LinkedInThreadRow[]> {
  return db
    .select({
      threadId: outreachThreads.id,
      state: outreachThreads.state,
      contactId: contacts.id,
      contactName: contacts.name,
      linkedinUrl: contacts.linkedinUrl,
      reviewItemId: outreachThreads.reviewItemId,
    })
    .from(outreachThreads)
    .innerJoin(contacts, eq(contacts.id, outreachThreads.contactId))
    .where(eq(outreachThreads.channel, 'linkedin'));
}

// ---------------------------------------------------------------------------
// Phase 11: apply targets
// ---------------------------------------------------------------------------

const APPLY_SOURCES: Record<string, 'greenhouse' | 'lever' | 'ashby'> = {
  'source-greenhouse': 'greenhouse',
  'source-lever': 'lever',
  'source-ashby': 'ashby',
};

export interface ApplyTarget {
  ats: 'greenhouse' | 'lever' | 'ashby';
  boardToken: string;
  postingId: string;
  url: string | null;
}

/** The first Greenhouse/Lever/Ashby posting behind a canonical job (Workday/SF/Taleo apply stays manual). */
export async function applyTargetForJob(db: DB, jobId: string): Promise<ApplyTarget | null> {
  const rows = await db.execute<{ source_plugin: string; external_id: string; url: string | null; board_token: string | null }>(sql`
    select r.source_plugin, r.external_id, r.url, s.board_token
    from raw_postings r left join company_sources s on s.id = r.company_source_id
    where r.canonical_job_id = ${jobId} and r.source_plugin in ('source-greenhouse', 'source-lever', 'source-ashby')
    order by r.last_seen_at desc`);
  for (const r of rows) {
    const ats = APPLY_SOURCES[r.source_plugin];
    if (ats && r.board_token) return { ats, boardToken: r.board_token, postingId: r.external_id, url: r.url };
  }
  return null;
}
