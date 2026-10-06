import type { Embedder, Logger } from '@jobforge/shared';
import { BGE_QUERY_PREFIX, jobEmbeddingText } from '@jobforge/embeddings';
import {
  factsNeedingEmbedding,
  getActiveProfile,
  jobsNeedingEmbedding,
  setFactEmbeddings,
  setJobEmbeddings,
  setSnapshotEmbedding,
  type DB,
} from '@jobforge/db';

export interface EmbedSummary {
  jobs: number;
  facts: number;
  profile: boolean;
}

/**
 * Embed everything that lacks a vector: open jobs (new or changed), active
 * facts, and the active profile summary (as a bge query). Safe to rerun.
 */
export async function embedPending(
  deps: { db: DB; embedder: Embedder; log: Logger },
  opts: { batchSize?: number; onProgress?: (done: number) => void } = {},
): Promise<EmbedSummary> {
  const { db, embedder, log } = deps;
  const batchSize = opts.batchSize ?? 64;
  const summary: EmbedSummary = { jobs: 0, facts: 0, profile: false };

  const profile = await getActiveProfile(db);
  if (profile && !profile.embedding && profile.summary.trim()) {
    const [v] = await embedder.embed([BGE_QUERY_PREFIX + profile.summary]);
    await setSnapshotEmbedding(db, profile.version, v!);
    summary.profile = true;
  }

  const facts = await factsNeedingEmbedding(db);
  for (let i = 0; i < facts.length; i += batchSize) {
    const batch = facts.slice(i, i + batchSize);
    const vecs = await embedder.embed(batch.map((f) => f.content));
    await setFactEmbeddings(db, batch.map((f, j) => ({ id: f.id, embedding: vecs[j]! })));
    summary.facts += batch.length;
  }

  for (;;) {
    const batch = await jobsNeedingEmbedding(db, batchSize);
    if (!batch.length) break;
    const vecs = await embedder.embed(batch.map(jobEmbeddingText));
    await setJobEmbeddings(db, batch.map((j, i) => ({ id: j.id, embedding: vecs[i]! })));
    summary.jobs += batch.length;
    opts.onProgress?.(summary.jobs);
  }
  log.info(summary, 'embeddings up to date');
  return summary;
}
