import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { DB } from './client.js';
import { actions, appState, companies, contacts, events, jobs, outreachThreads, reviewItems } from './schema.js';

export type ReviewItemRow = typeof reviewItems.$inferSelect;
export type ReviewStatus = ReviewItemRow['status'];
export type ReviewKind = ReviewItemRow['kind'];
export type ActionRow = typeof actions.$inferSelect;
export type ThreadRow = typeof outreachThreads.$inferSelect;

// ---------------------------------------------------------------------------
// review_items
// ---------------------------------------------------------------------------

export interface NewReviewItem {
  kind: ReviewKind;
  pluginId: string;
  jobId: string | null;
  contactId: string | null;
  companyId: string | null;
  threadId?: string | null;
  batchId?: string | null;
  draft: Record<string, unknown>;
  notBefore?: Date | null;
}

export async function createReviewItem(db: DB, r: NewReviewItem): Promise<ReviewItemRow> {
  const [row] = await db
    .insert(reviewItems)
    .values({ ...r, threadId: r.threadId ?? null, batchId: r.batchId ?? null, notBefore: r.notBefore ?? null, originalDraft: r.draft })
    .returning();
  return row!;
}

export async function getReviewItem(db: DB, id: string): Promise<ReviewItemRow | null> {
  const [r] = await db.select().from(reviewItems).where(eq(reviewItems.id, id));
  return r ?? null;
}

export interface ReviewListRow extends ReviewItemRow {
  contactName: string | null;
  contactEmail: string | null;
  contactEmailConfidence: number | null;
  companyName: string | null;
  jobTitle: string | null;
}

export async function listReviewItems(
  db: DB,
  f: { status?: ReviewStatus[]; kind?: ReviewKind[]; limit?: number; ids?: string[]; companyId?: string } = {},
): Promise<ReviewListRow[]> {
  const conds: SQL[] = [];
  if (f.companyId) conds.push(eq(reviewItems.companyId, f.companyId));
  if (f.status?.length) conds.push(inArray(reviewItems.status, f.status));
  if (f.kind?.length) conds.push(inArray(reviewItems.kind, f.kind));
  if (f.ids?.length) conds.push(inArray(reviewItems.id, f.ids));
  const rows = await db
    .select({
      r: reviewItems,
      contactName: contacts.name,
      contactEmail: contacts.email,
      contactEmailConfidence: contacts.emailConfidence,
      companyName: companies.name,
      jobTitle: jobs.title,
    })
    .from(reviewItems)
    .leftJoin(contacts, eq(contacts.id, reviewItems.contactId))
    .leftJoin(companies, eq(companies.id, reviewItems.companyId))
    .leftJoin(jobs, eq(jobs.id, reviewItems.jobId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(reviewItems.createdAt))
    .limit(f.limit ?? 100);
  return rows.map(({ r, ...rest }) => ({ ...r, ...rest }));
}

/** Replace the draft. Only pending items can be edited; returns null otherwise. */
export async function updatePendingDraft(db: DB, id: string, draft: Record<string, unknown>): Promise<ReviewItemRow | null> {
  const [r] = await db
    .update(reviewItems)
    .set({ draft, editedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(reviewItems.id, id), eq(reviewItems.status, 'pending')))
    .returning();
  return r ?? null;
}

/** Atomic status transition; returns null when the item isn't in one of `from`. */
export async function transitionReviewItem(
  db: DB,
  id: string,
  from: ReviewStatus[],
  to: ReviewStatus,
  extra: {
    decisionNote?: string | null;
    overrideCompanyCap?: boolean;
    error?: string | null;
    decided?: boolean;
    /** 'human' | 'autopilot' — only set at decision time. */
    decidedBy?: 'human' | 'autopilot';
    confidence?: number | null;
  } = {},
): Promise<ReviewItemRow | null> {
  const [r] = await db
    .update(reviewItems)
    .set({
      status: to,
      updatedAt: new Date(),
      ...(extra.decided ? { decidedAt: new Date() } : {}),
      ...(extra.decidedBy ? { decidedBy: extra.decidedBy } : {}),
      ...(extra.confidence !== undefined ? { confidence: extra.confidence } : {}),
      ...(extra.decisionNote !== undefined ? { decisionNote: extra.decisionNote } : {}),
      ...(extra.overrideCompanyCap !== undefined ? { overrideCompanyCap: extra.overrideCompanyCap } : {}),
      ...(extra.error !== undefined ? { error: extra.error?.slice(0, 2000) ?? null } : {}),
    })
    .where(and(eq(reviewItems.id, id), inArray(reviewItems.status, from)))
    .returning();
  return r ?? null;
}

/** Approved items whose not_before has passed, oldest decision first (optionally one actor's). */
export async function approvedDueItems(db: DB, now: Date, limit = 50, pluginId?: string): Promise<ReviewItemRow[]> {
  return db
    .select()
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.status, 'approved'),
        or(isNull(reviewItems.notBefore), lte(reviewItems.notBefore, now)),
        pluginId ? eq(reviewItems.pluginId, pluginId) : undefined,
      ),
    )
    .orderBy(asc(reviewItems.decidedAt), asc(reviewItems.createdAt))
    .limit(limit);
}

export async function cancelPendingFollowups(db: DB, threadId: string, note: string): Promise<number> {
  const rows = await db
    .update(reviewItems)
    .set({ status: 'cancelled', decisionNote: note, updatedAt: new Date() })
    .where(and(eq(reviewItems.threadId, threadId), eq(reviewItems.kind, 'followup'), inArray(reviewItems.status, ['pending', 'approved'])))
    .returning({ id: reviewItems.id });
  return rows.length;
}

export async function reviewCounts(db: DB): Promise<Record<ReviewStatus, number>> {
  const rows = await db
    .select({ status: reviewItems.status, n: sql<number>`count(*)::int` })
    .from(reviewItems)
    .groupBy(reviewItems.status);
  const out = { pending: 0, approved: 0, rejected: 0, executed: 0, failed: 0, cancelled: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// ---------------------------------------------------------------------------
// actions (idempotency)
// ---------------------------------------------------------------------------

/**
 * Claim an idempotency key. Returns the new row, or the existing row when the
 * key was already used (the caller must not repeat a succeeded side effect).
 */
export async function claimAction(
  db: DB,
  a: { reviewItemId: string; pluginId: string; idempotencyKey: string; dryRun: boolean },
): Promise<{ action: ActionRow; existing: boolean }> {
  const [row] = await db
    .insert(actions)
    .values({ ...a, status: 'started' })
    .onConflictDoNothing({ target: actions.idempotencyKey })
    .returning();
  if (row) return { action: row, existing: false };
  const [existing] = await db.select().from(actions).where(eq(actions.idempotencyKey, a.idempotencyKey));
  return { action: existing!, existing: true };
}

/** Re-open a failed or interrupted attempt for another try under the same key. */
export async function restartAction(db: DB, id: string): Promise<void> {
  await db.update(actions).set({ status: 'started', error: null, startedAt: new Date() }).where(eq(actions.id, id));
}

export async function finishAction(
  db: DB,
  id: string,
  r: { status: 'succeeded' | 'failed'; result?: unknown; error?: string; at?: Date },
): Promise<void> {
  await db
    .update(actions)
    .set({ status: r.status, result: r.result ?? null, error: r.error?.slice(0, 4000) ?? null, executedAt: r.at ?? new Date() })
    .where(eq(actions.id, id));
}

export async function actionsForReviewItem(db: DB, reviewItemId: string): Promise<ActionRow[]> {
  return db.select().from(actions).where(eq(actions.reviewItemId, reviewItemId)).orderBy(desc(actions.startedAt));
}

/** Real (non-dry-run) emails sent by this plugin since `since`. */
export async function liveSendsSince(db: DB, pluginId: string, since: Date): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(actions)
    .where(
      and(
        eq(actions.pluginId, pluginId),
        eq(actions.status, 'succeeded'),
        eq(actions.dryRun, false),
        sql`${actions.executedAt} >= ${since.toISOString()}::timestamptz`,
      ),
    );
  return r!.n;
}

export async function lastLiveSendAt(db: DB, pluginId: string): Promise<Date | null> {
  const [r] = await db
    .select({ at: sql<Date | null>`max(${actions.executedAt})` })
    .from(actions)
    .where(and(eq(actions.pluginId, pluginId), eq(actions.status, 'succeeded'), eq(actions.dryRun, false)));
  return r?.at ? new Date(r.at) : null;
}

/** Distinct contacts at a company that received a first (non-follow-up) live email since `since`. */
export async function contactsEmailedAtCompanySince(db: DB, companyId: string, since: Date): Promise<string[]> {
  const rows = await db
    .selectDistinct({ contactId: reviewItems.contactId })
    .from(actions)
    .innerJoin(reviewItems, eq(reviewItems.id, actions.reviewItemId))
    .where(
      and(
        eq(reviewItems.companyId, companyId),
        inArray(reviewItems.kind, ['outreach', 'referral_ask']),
        eq(actions.status, 'succeeded'),
        eq(actions.dryRun, false),
        sql`${actions.executedAt} >= ${since.toISOString()}::timestamptz`,
      ),
    );
  return rows.map((r) => r.contactId).filter((x): x is string => !!x);
}

// ---------------------------------------------------------------------------
// outreach_threads
// ---------------------------------------------------------------------------

export async function createThread(
  db: DB,
  t: {
    contactId: string;
    companyId: string | null;
    jobId: string | null;
    reviewItemId: string;
    gmailThreadId: string;
    subject: string;
    messageId: string;
    sentAt: Date;
    nextFollowupAt: Date | null;
    channel?: 'email' | 'linkedin';
  },
): Promise<ThreadRow> {
  const [row] = await db
    .insert(outreachThreads)
    .values({
      contactId: t.contactId,
      companyId: t.companyId,
      jobId: t.jobId,
      reviewItemId: t.reviewItemId,
      gmailThreadId: t.gmailThreadId,
      subject: t.subject,
      messageIds: [t.messageId],
      sentAt: t.sentAt,
      lastSentAt: t.sentAt,
      nextFollowupAt: t.nextFollowupAt,
      channel: t.channel ?? 'email',
    })
    .onConflictDoUpdate({ target: outreachThreads.gmailThreadId, set: { updatedAt: new Date() } })
    .returning();
  return row!;
}

export async function getThread(db: DB, id: string): Promise<ThreadRow | null> {
  const [r] = await db.select().from(outreachThreads).where(eq(outreachThreads.id, id));
  return r ?? null;
}

export async function threadsByGmailIds(db: DB, gmailThreadIds: string[]): Promise<ThreadRow[]> {
  if (!gmailThreadIds.length) return [];
  return db.select().from(outreachThreads).where(inArray(outreachThreads.gmailThreadId, gmailThreadIds));
}

export async function recordFollowupSent(db: DB, threadId: string, messageId: string, at: Date, nextFollowupAt: Date | null): Promise<void> {
  await db
    .update(outreachThreads)
    .set({
      messageIds: sql`array_append(${outreachThreads.messageIds}, ${messageId})`,
      followupsSent: sql`${outreachThreads.followupsSent} + 1`,
      lastSentAt: at,
      nextFollowupAt,
      updatedAt: new Date(),
    })
    .where(eq(outreachThreads.id, threadId));
}

/** Only threads still in `sent` change state: a reply after a bounce (or vice versa) is recorded once. */
export async function markThread(db: DB, id: string, state: 'replied' | 'bounced' | 'closed', at: Date): Promise<ThreadRow | null> {
  const [r] = await db
    .update(outreachThreads)
    .set({
      state,
      nextFollowupAt: null,
      ...(state === 'replied' ? { repliedAt: at } : state === 'bounced' ? { bouncedAt: at } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(outreachThreads.id, id), eq(outreachThreads.state, 'sent')))
    .returning();
  return r ?? null;
}

/** Sent threads whose follow-up is due and that have no follow-up already queued. */
export async function threadsDueForFollowup(db: DB, now: Date, maxFollowups: number): Promise<ThreadRow[]> {
  return db
    .select()
    .from(outreachThreads)
    .where(
      and(
        eq(outreachThreads.state, 'sent'),
        lte(outreachThreads.nextFollowupAt, now),
        sql`${outreachThreads.followupsSent} < ${maxFollowups}`,
        sql`not exists (select 1 from ${reviewItems} r where r.thread_id = ${outreachThreads.id}
              and r.kind = 'followup' and r.status in ('pending', 'approved'))`,
      ),
    )
    .orderBy(asc(outreachThreads.nextFollowupAt));
}

export async function listThreads(
  db: DB,
  f: { states?: ThreadRow['state'][]; jobId?: string | undefined; companyId?: string | undefined; limit?: number } = {},
) {
  const conds: SQL[] = [];
  if (f.companyId) conds.push(eq(outreachThreads.companyId, f.companyId));
  if (f.states?.length) conds.push(inArray(outreachThreads.state, f.states));
  if (f.jobId) conds.push(eq(outreachThreads.jobId, f.jobId));
  const rows = await db
    .select({ t: outreachThreads, contactName: contacts.name, contactEmail: contacts.email, companyName: companies.name })
    .from(outreachThreads)
    .innerJoin(contacts, eq(contacts.id, outreachThreads.contactId))
    .leftJoin(companies, eq(companies.id, outreachThreads.companyId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(outreachThreads.lastSentAt))
    .limit(f.limit ?? 100);
  return rows.map(({ t, ...rest }) => ({ ...t, ...rest }));
}

export async function threadCounts(db: DB): Promise<Record<ThreadRow['state'], number>> {
  const rows = await db
    .select({ state: outreachThreads.state, n: sql<number>`count(*)::int` })
    .from(outreachThreads)
    .groupBy(outreachThreads.state);
  const out = { sent: 0, replied: 0, bounced: 0, closed: 0 };
  for (const r of rows) out[r.state] = r.n;
  return out;
}

// ---------------------------------------------------------------------------
// app_state
// ---------------------------------------------------------------------------

export async function getState<T>(db: DB, key: string): Promise<T | null> {
  const [r] = await db.select().from(appState).where(eq(appState.key, key));
  return (r?.value as T | undefined) ?? null;
}

export async function setState(db: DB, key: string, value: unknown): Promise<void> {
  await db
    .insert(appState)
    .values({ key, value })
    .onConflictDoUpdate({ target: appState.key, set: { value: sql`excluded.value`, updatedAt: new Date() } });
}

/**
 * A crude cross-process lock in app_state: acquired when the key is free,
 * expired, or already held by `owner`. Keeps two send loops from racing.
 */
export async function tryLease(db: DB, key: string, owner: string, ttlMs: number): Promise<boolean> {
  const until = new Date(Date.now() + ttlMs).toISOString();
  const rows = await db.execute(sql`
    insert into ${appState} (key, value, updated_at)
    values (${key}, jsonb_build_object('owner', ${owner}::text, 'until', ${until}::text), now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where (${appState.value}->>'until')::timestamptz < now() or ${appState.value}->>'owner' = ${owner}
    returning key`);
  return rows.length > 0;
}

export async function releaseLease(db: DB, key: string, owner: string): Promise<void> {
  await db.execute(sql`delete from ${appState} where key = ${key} and ${appState.value}->>'owner' = ${owner}`);
}

/** Executed items in a thread (first email + follow-ups), newest first. */
export async function executedItemsForThread(db: DB, threadId: string, firstReviewItemId: string | null): Promise<ReviewItemRow[]> {
  return db
    .select()
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.status, 'executed'),
        firstReviewItemId ? or(eq(reviewItems.threadId, threadId), eq(reviewItems.id, firstReviewItemId)) : eq(reviewItems.threadId, threadId),
      ),
    )
    .orderBy(desc(reviewItems.updatedAt));
}

/** Count review items the autopilot auto-approved since `since`. */
export async function autopilotApprovesSince(db: DB, since: Date): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviewItems)
    .where(and(eq(reviewItems.decidedBy, 'autopilot'), gte(reviewItems.decidedAt, since)));
  return r?.n ?? 0;
}

/** Active (pending/approved) first-email items for a contact, to avoid duplicate drafts. */
export async function openOutreachForContact(db: DB, contactId: string): Promise<ReviewItemRow[]> {
  return db
    .select()
    .from(reviewItems)
    .where(and(eq(reviewItems.contactId, contactId), eq(reviewItems.kind, 'outreach'), inArray(reviewItems.status, ['pending', 'approved'])));
}

export async function threadsForContact(db: DB, contactId: string): Promise<ThreadRow[]> {
  return db.select().from(outreachThreads).where(eq(outreachThreads.contactId, contactId)).orderBy(desc(outreachThreads.sentAt));
}

/** Most recent sent thread to an address (to place a bounce that arrived outside its thread). */
export async function latestSentThreadToEmail(db: DB, email: string): Promise<ThreadRow | null> {
  const [r] = await db
    .select({ t: outreachThreads })
    .from(outreachThreads)
    .innerJoin(contacts, eq(contacts.id, outreachThreads.contactId))
    .where(and(eq(outreachThreads.state, 'sent'), sql`lower(${contacts.email}) = lower(${email})`))
    .orderBy(desc(outreachThreads.lastSentAt))
    .limit(1);
  return r?.t ?? null;
}

/** How many times an event happened for a subject (e.g. failed send attempts for a review item). */
export async function countEvents(db: DB, kind: string, subjectId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.kind, kind), eq(events.subjectId, subjectId)));
  return r!.n;
}

/** Hand an idempotency key's (failed) action over to a new review item. */
export async function reassignAction(db: DB, actionId: string, reviewItemId: string): Promise<void> {
  await db.update(actions).set({ reviewItemId }).where(eq(actions.id, actionId));
}
