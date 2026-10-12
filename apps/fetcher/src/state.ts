import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { RawPosting } from '@quarry/plugin-sdk';

// What the phone has already put in a batch, per board: externalId -> content
// hash. Only advanced after a batch is safely written, so a crash resends
// rather than loses. Delete the file (or run with --full) to resend everything,
// e.g. after the laptop's database was reset.

const stateSchema = z.object({
  version: z.literal(1),
  boards: z.record(z.record(z.string())),
  lastRunAt: z.string().nullable(),
});
export type FetchState = z.infer<typeof stateSchema>;

export const emptyState = (): FetchState => ({ version: 1, boards: {}, lastRunAt: null });

export function readState(path: string): FetchState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return emptyState();
  }
  const parsed = stateSchema.safeParse(JSON.parse(text));
  // An unreadable state only costs a full resend; never refuse to run over it.
  return parsed.success ? parsed.data : emptyState();
}

export function writeState(path: string, state: FetchState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.part`, JSON.stringify(state));
  renameSync(`${path}.part`, path);
}

/** Content hash of a posting. The payload is left out: it carries volatile fields some boards change every fetch. */
export function postingHash(p: RawPosting): string {
  const { payload: _payload, ...rest } = p;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 32);
}
