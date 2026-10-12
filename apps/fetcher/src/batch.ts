import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { rawPostingSchema } from '@quarry/plugin-sdk';
import { ATS_TYPES } from '@quarry/shared';

// A fetch batch: one board fetched once, written by the phone and imported by
// the laptop. It is the wire format between the two, so it is versioned and
// validated on both ends. Batches are applied in file-name order (start time).
//
// To keep the outbox small, a posting travels in full only when it is new or
// changed since the last batch for that board; the rest are listed by
// externalId in `unchanged` so the importer can still mark them as seen. When
// `ok`, `postings` + `unchanged` is the whole board (after the filter), so the
// importer may close jobs that are missing from it.

export const BATCH_KIND = 'quarry.fetch-batch';
export const BATCH_VERSION = 1;

/** A raw posting as it survives JSON (dates come back as strings). */
export const batchPostingSchema = rawPostingSchema.extend({ postedAt: z.coerce.date().nullable() });
export type BatchPosting = z.infer<typeof batchPostingSchema>;

export const fetchBatchSchema = z.object({
  kind: z.literal(BATCH_KIND),
  version: z.literal(BATCH_VERSION),
  id: z.string().uuid(),
  /** Which device wrote it (hostname). */
  device: z.string(),
  board: z.object({
    companyName: z.string().min(1),
    atsType: z.enum(ATS_TYPES),
    boardToken: z.string().min(1),
    sourcePlugin: z.string().min(1),
  }),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date(),
  ok: z.boolean(),
  error: z.string().nullable(),
  /** True when retrying can't help (e.g. the board 404s). */
  permanent: z.boolean(),
  /** Whether the preferences' hard filters were applied, and to which preferences. */
  filter: z.object({ applied: z.boolean(), preferencesHash: z.string().nullable() }),
  counts: z.object({
    postings: z.number().int(),
    invalid: z.number().int(),
    filtered: z.number().int(),
    sent: z.number().int(),
    unchanged: z.number().int(),
  }),
  /** New or changed postings that passed the filter, in full. `hash` is their content hash. */
  postings: z.array(z.object({ hash: z.string(), posting: batchPostingSchema })),
  /** externalIds of passing postings sent in an earlier batch and unchanged since. */
  unchanged: z.array(z.string()),
  /** What the filter dropped and why (title only; enough to audit the preferences). */
  filtered: z.array(z.object({ externalId: z.string(), title: z.string(), reason: z.string() })),
});
export type FetchBatch = z.infer<typeof fetchBatchSchema>;

export type NewBatch = Omit<FetchBatch, 'kind' | 'version' | 'id'>;

/** File names sort by start time, so a directory listing is the import order. */
export function batchFileName(b: Pick<FetchBatch, 'startedAt' | 'board' | 'id'>): string {
  const ts = b.startedAt.toISOString().replace(/[:.]/g, '-');
  const token = b.board.boardToken.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
  return `${ts}_${b.board.atsType}_${token}_${b.id.slice(0, 8)}.json`;
}

/** Write a batch atomically (temp file + rename) so a reader never sees half a file. */
export function writeBatch(outbox: string, batch: NewBatch): { path: string; batch: FetchBatch } {
  const full: FetchBatch = { kind: BATCH_KIND, version: BATCH_VERSION, id: randomUUID(), ...batch };
  mkdirSync(outbox, { recursive: true });
  const path = join(outbox, batchFileName(full));
  writeFileSync(`${path}.part`, JSON.stringify(full));
  renameSync(`${path}.part`, path);
  return { path, batch: full };
}

export function parseBatch(text: string): FetchBatch {
  return fetchBatchSchema.parse(JSON.parse(text));
}

/** Batch files waiting in the outbox, oldest first. */
export function listBatchFiles(outbox: string): string[] {
  let names: string[];
  try {
    names = readdirSync(outbox);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).sort().map((n) => join(outbox, n));
}

export function readBatch(path: string): FetchBatch {
  return parseBatch(readFileSync(path, 'utf8'));
}
