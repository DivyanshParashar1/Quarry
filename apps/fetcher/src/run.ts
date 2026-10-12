import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { buildContext, normalizePosting, type ContextDeps, type PluginRegistry } from '@quarry/core/fetch';
import { applyHardFilters, type FilterOptions } from '@quarry/matcher-default';
import { HttpError, rawPostingSchema, type Job, type RawPosting } from '@quarry/plugin-sdk';
import { SOURCE_PLUGIN_FOR_ATS, type Logger, type Preferences } from '@quarry/shared';
import { boardKey, type Board } from './boards.js';
import { writeBatch, type NewBatch } from './batch.js';
import { postingHash, type FetchState } from './state.js';

export interface FetchDeps extends Omit<ContextDeps, 'signal' | 'log' | 'dryRun'> {
  registry: PluginRegistry;
  log: Logger;
  outbox: string;
  /** null = no filtering: every posting goes to the laptop. */
  preferences: Preferences | null;
  filterOptions: FilterOptions;
  /** Ignore what earlier batches sent: every passing posting goes in full. */
  full?: boolean;
  /** Hard cap on one board fetch. */
  timeoutMs?: number;
  /** Aborts the whole run (Ctrl-C). */
  signal?: AbortSignal;
  now?: () => Date;
  device?: string;
}

export interface BoardSummary {
  board: Board;
  ok: boolean;
  error: string | null;
  postings: number;
  filtered: number;
  sent: number;
  unchanged: number;
  batchPath: string;
}

/**
 * Fetch one board and write its batch. Never throws for a board failure: a
 * failed fetch still writes a batch (ok: false) so the laptop sees the error,
 * and the state for that board is left alone.
 */
export async function fetchBoard(deps: FetchDeps, state: FetchState, board: Board): Promise<BoardSummary> {
  const now = deps.now ?? (() => new Date());
  const pluginId = SOURCE_PLUGIN_FOR_ATS[board.atsType]!;
  const loaded = deps.registry.source(pluginId);
  const log = deps.log.child({ plugin: pluginId, company: board.companyName, board: board.boardToken });
  const signal = AbortSignal.any([
    AbortSignal.timeout(deps.timeoutMs ?? 5 * 60_000),
    ...(deps.signal ? [deps.signal] : []),
  ]);
  // Fetching is read-only, so the plugin always runs in dry-run mode.
  const ctx = buildContext(loaded, { ...deps, log, signal, dryRun: true });
  const key = boardKey(board);
  const known = deps.full ? {} : (state.boards[key] ?? {});
  const startedAt = now();

  const batch: NewBatch = {
    device: deps.device ?? hostname(),
    board: { companyName: board.companyName, atsType: board.atsType, boardToken: board.boardToken, sourcePlugin: pluginId },
    startedAt,
    finishedAt: startedAt,
    ok: false,
    error: null,
    permanent: false,
    filter: { applied: deps.preferences !== null, preferencesHash: deps.preferences ? preferencesHash(deps.preferences) : null },
    counts: { postings: 0, invalid: 0, filtered: 0, sent: 0, unchanged: 0 },
    postings: [],
    unchanged: [],
    filtered: [],
  };
  const seen: Record<string, string> = {};

  try {
    for await (const item of loaded.plugin.fetch(ctx, {
      companySourceId: key,
      companyId: key,
      companyName: board.companyName,
      boardToken: board.boardToken,
      ...(board.options && Object.keys(board.options).length ? { options: board.options } : {}),
    })) {
      batch.counts.postings++;
      const parsed = rawPostingSchema.safeParse(item);
      if (!parsed.success) {
        batch.counts.invalid++;
        log.warn({ issues: parsed.error.issues.slice(0, 3) }, 'plugin yielded an invalid posting; skipped');
        continue;
      }
      const raw = parsed.data;
      const reason = deps.preferences ? filterReason(raw, board.companyName, deps.preferences, deps.filterOptions) : null;
      if (reason) {
        batch.filtered.push({ externalId: raw.externalId, title: raw.title, reason });
        continue;
      }
      const hash = postingHash(raw);
      seen[raw.externalId] = hash;
      if (known[raw.externalId] === hash) batch.unchanged.push(raw.externalId);
      else batch.postings.push({ hash, posting: raw });
    }
    batch.ok = true;
  } catch (err) {
    batch.error = errorMessage(err);
    batch.permanent = err instanceof HttpError && err.permanent;
    log.warn({ err: batch.error, permanent: batch.permanent }, 'board fetch failed');
  }

  batch.finishedAt = now();
  batch.counts.filtered = batch.filtered.length;
  batch.counts.sent = batch.postings.length;
  batch.counts.unchanged = batch.unchanged.length;
  // A failed fetch carries no postings: a partial board must not look complete.
  if (!batch.ok) {
    batch.postings = [];
    batch.unchanged = [];
    batch.filtered = [];
  }
  const { path } = writeBatch(deps.outbox, batch);
  if (batch.ok) state.boards[key] = seen;
  if (batch.ok) log.info({ postings: batch.counts.postings, sent: batch.counts.sent, filtered: batch.counts.filtered }, 'board fetched');

  return {
    board,
    ok: batch.ok,
    error: batch.error,
    postings: batch.counts.postings,
    filtered: batch.counts.filtered,
    sent: batch.counts.sent,
    unchanged: batch.counts.unchanged,
    batchPath: path,
  };
}

/** Fetch every board, `concurrency` at a time (the per-domain rate limiter still applies across them). */
export async function fetchBoards(
  deps: FetchDeps,
  state: FetchState,
  boards: Board[],
  o: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<BoardSummary[]> {
  const results: BoardSummary[] = new Array(boards.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < boards.length && !deps.signal?.aborted) {
      const i = next++;
      results[i] = await fetchBoard(deps, state, boards[i]!);
      o.onProgress?.(++done, boards.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  state.lastRunAt = (deps.now ?? (() => new Date()))().toISOString();
  return results.filter(Boolean);
}

/** The matcher's own hard filters, run on the phone so jobs you'd never want don't travel. */
export function filterReason(raw: RawPosting, companyName: string, p: Preferences, o: FilterOptions): string | null {
  const company = raw.companyName ?? companyName;
  const n = normalizePosting(raw, company);
  const job: Job = {
    id: raw.externalId,
    companyId: '',
    company,
    title: n.title,
    normalizedTitle: n.normalizedTitle,
    locations: n.locations,
    remotePolicy: n.remotePolicy,
    seniority: n.seniority,
    descriptionMd: n.descriptionMd,
    applyUrl: n.applyUrl,
    postedAt: n.postedAt,
    embedding: null,
  };
  return applyHardFilters(job, p, o);
}

export function preferencesHash(p: Preferences): string {
  return createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.name === 'Error' ? err.message : `${err.name}: ${err.message}`;
  return String(err);
}
