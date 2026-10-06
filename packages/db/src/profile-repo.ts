import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { Preferences, Profile, ProfileFact } from '@jobforge/shared';
import type { DB } from './client.js';
import { profileFacts, profileSnapshots } from './schema.js';

export interface ProfileSyncInput {
  version: string;
  facts: (ProfileFact & { contentHash: string })[];
  preferences: Preferences;
  summary: string;
}

export interface ProfileSyncResult {
  version: string;
  snapshotCreated: boolean;
  factsCreated: number;
  factsUpdated: number;
  factsUnchanged: number;
  factsRetired: number;
}

/**
 * Write the YAML profile into the DB in one transaction. Facts are upserted by
 * id (version bumped and embedding cleared when content changes); ids no
 * longer in the YAML are retired, never deleted, so old tailored bullets keep
 * their provenance. The snapshot becomes the active profile.
 */
export async function syncProfile(db: DB, input: ProfileSyncInput): Promise<ProfileSyncResult> {
  return db.transaction(async (tx) => {
    const existing = new Map(
      (
        await tx
          .select({ id: profileFacts.id, contentHash: profileFacts.contentHash, retiredAt: profileFacts.retiredAt })
          .from(profileFacts)
      ).map((r) => [r.id, r]),
    );
    const res: ProfileSyncResult = {
      version: input.version,
      snapshotCreated: false,
      factsCreated: 0,
      factsUpdated: 0,
      factsUnchanged: 0,
      factsRetired: 0,
    };

    for (const f of input.facts) {
      const prev = existing.get(f.id);
      if (!prev) {
        await tx.insert(profileFacts).values({
          id: f.id,
          kind: f.kind,
          content: f.content,
          metrics: f.metrics,
          tags: f.tags,
          contentHash: f.contentHash,
        });
        res.factsCreated++;
      } else if (prev.contentHash !== f.contentHash || prev.retiredAt) {
        const changed = prev.contentHash !== f.contentHash;
        await tx
          .update(profileFacts)
          .set({
            kind: f.kind,
            content: f.content,
            metrics: f.metrics,
            tags: f.tags,
            contentHash: f.contentHash,
            retiredAt: null,
            updatedAt: new Date(),
            ...(changed ? { version: sql`${profileFacts.version} + 1`, embedding: null } : {}),
          })
          .where(eq(profileFacts.id, f.id));
        res.factsUpdated++;
      } else {
        res.factsUnchanged++;
      }
    }

    const ids = input.facts.map((f) => f.id);
    const retired = await tx
      .update(profileFacts)
      .set({ retiredAt: new Date() })
      .where(and(isNull(profileFacts.retiredAt), ids.length ? notInArray(profileFacts.id, ids) : undefined))
      .returning({ id: profileFacts.id });
    res.factsRetired = retired.length;

    const [snap] = await tx
      .insert(profileSnapshots)
      .values({ version: input.version, preferences: input.preferences, factIds: ids, summary: input.summary })
      .onConflictDoUpdate({ target: profileSnapshots.version, set: { loadedAt: new Date() } })
      .returning({ created: sql<boolean>`(xmax = 0)` });
    res.snapshotCreated = snap!.created;
    return res;
  });
}

/** The most recently loaded snapshot with its facts, or null if no profile was loaded yet. */
export async function getActiveProfile(db: DB): Promise<Profile | null> {
  const [snap] = await db.select().from(profileSnapshots).orderBy(desc(profileSnapshots.loadedAt)).limit(1);
  if (!snap) return null;
  const facts = snap.factIds.length
    ? await db.select().from(profileFacts).where(inArray(profileFacts.id, snap.factIds)).orderBy(asc(profileFacts.id))
    : [];
  return {
    version: snap.version,
    preferences: snap.preferences as Preferences,
    facts: facts.map((f) => ({
      id: f.id,
      kind: f.kind,
      content: f.content,
      metrics: f.metrics as ProfileFact['metrics'],
      tags: f.tags,
    })),
    summary: snap.summary,
    embedding: snap.embedding,
  };
}

export async function setSnapshotEmbedding(db: DB, version: string, embedding: number[]): Promise<void> {
  await db.update(profileSnapshots).set({ embedding }).where(eq(profileSnapshots.version, version));
}

export async function factsNeedingEmbedding(db: DB): Promise<{ id: string; content: string }[]> {
  return db
    .select({ id: profileFacts.id, content: profileFacts.content })
    .from(profileFacts)
    .where(and(isNull(profileFacts.embedding), isNull(profileFacts.retiredAt)))
    .orderBy(asc(profileFacts.id));
}

export async function setFactEmbeddings(db: DB, rows: { id: string; embedding: number[] }[]): Promise<void> {
  for (const r of rows) await db.update(profileFacts).set({ embedding: r.embedding }).where(eq(profileFacts.id, r.id));
}
