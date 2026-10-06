import { PgBoss } from 'pg-boss';
import { listSourceTargets } from '@jobforge/db';
import { runSourceTarget, type SourceRunDeps, type SourceRunSummary } from './source-runner.js';

export const QUEUES = {
  sourceFetch: 'source.fetch',
} as const;

export interface SourceFetchJob {
  companySourceId: string;
}

export async function startBoss(databaseUrl: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss', application_name: 'jobforge' });
  boss.on('error', () => {
    /* surfaced via job failures; avoid unhandled 'error' events crashing the process */
  });
  await boss.start();
  // ScopedHttp already retries transient HTTP failures, so the queue only
  // retries once more for things like a DB blip.
  const existing = await boss.getQueue(QUEUES.sourceFetch).catch(() => null);
  if (!existing) {
    await boss.createQueue(QUEUES.sourceFetch, {
      retryLimit: 1,
      retryDelay: 15,
      retryBackoff: true,
      expireInSeconds: 15 * 60,
    });
  }
  return boss;
}

/**
 * Register the stage worker for source fetches. Each board is its own job, so
 * a failure is isolated; permanent failures (404 board) complete without retry.
 */
export async function registerSourceWorker(
  boss: PgBoss,
  deps: SourceRunDeps,
  opts: { concurrency?: number } = {},
): Promise<string> {
  return boss.work<SourceFetchJob, SourceRunSummary>(
    QUEUES.sourceFetch,
    { localConcurrency: opts.concurrency ?? 4, batchSize: 1, pollingIntervalSeconds: 0.5 },
    async ([job]) => {
      const [row] = await listSourceTargets(deps.db, { ids: [job!.data.companySourceId], includePaused: true });
      if (!row) throw new Error(`company_source ${job!.data.companySourceId} not found`);
      const summary = await runSourceTarget(deps, row);
      if (!summary.ok && !summary.permanent) throw new Error(summary.error);
      return summary;
    },
  );
}

export async function enqueueSourceFetches(boss: PgBoss, companySourceIds: string[]): Promise<string[]> {
  if (!companySourceIds.length) return [];
  const ids = await boss.insert(
    QUEUES.sourceFetch,
    companySourceIds.map((id) => ({ data: { companySourceId: id } satisfies SourceFetchJob })),
    { returnId: true },
  );
  return ids ?? [];
}

export type FinalState = 'completed' | 'failed' | 'cancelled';

/** Poll until every job reaches a terminal state. Returns each job's final state and output. */
export async function waitForJobs(
  boss: PgBoss,
  queue: string,
  ids: string[],
  opts: { pollMs?: number; timeoutMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, { state: FinalState; output: unknown }>> {
  const done = new Map<string, { state: FinalState; output: unknown }>();
  const deadline = Date.now() + (opts.timeoutMs ?? 60 * 60_000);
  while (done.size < ids.length) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${ids.length - done.size} jobs`);
    for (const id of ids) {
      if (done.has(id)) continue;
      const job = await boss.getJobById(queue, id);
      if (job && (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled')) {
        done.set(id, { state: job.state, output: job.output });
      }
    }
    opts.onProgress?.(done.size, ids.length);
    if (done.size < ids.length) await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
  }
  return done;
}
