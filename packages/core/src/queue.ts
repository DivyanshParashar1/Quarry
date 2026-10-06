import { PgBoss } from 'pg-boss';
import { listSourceTargets } from '@jobforge/db';
import { runSourceTarget, type SourceRunDeps, type SourceRunSummary } from './source-runner.js';
import { draftDueFollowups, pollTracker, runSendTick, type OutreachDeps } from './outreach.js';

export const QUEUES = {
  sourceFetch: 'source.fetch',
  outreachSend: 'outreach.send',
  outreachTrack: 'outreach.track',
  outreachFollowups: 'outreach.followups',
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

/**
 * Scheduled outreach loops. Tracking and follow-up drafting need Gmail; the
 * send loop runs only in live mode (dry-run previews are a CLI action). Each
 * loop is idempotent and the send loop holds a lease, so overlaps are harmless.
 */
export async function registerOutreachWorkers(
  boss: PgBoss,
  deps: () => Promise<OutreachDeps>,
  opts: { live: boolean; gmailConnected: boolean; log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void } },
): Promise<string[]> {
  const enabled: string[] = [];
  const loops: [string, string, (d: OutreachDeps) => Promise<unknown>, boolean][] = [
    [QUEUES.outreachSend, '* * * * *', runSendTick, opts.live && opts.gmailConnected],
    [QUEUES.outreachTrack, '*/10 * * * *', (d) => pollTracker(d), opts.gmailConnected],
    [QUEUES.outreachFollowups, '17 * * * *', draftDueFollowups, opts.gmailConnected],
  ];
  for (const [name, cron, fn, on] of loops) {
    if (!(await boss.getQueue(name).catch(() => null))) {
      await boss.createQueue(name, { retryLimit: 0, expireInSeconds: 10 * 60 });
    }
    if (!on) {
      await boss.unschedule(name).catch(() => {});
      continue;
    }
    await boss.schedule(name, cron);
    await boss.work(name, { localConcurrency: 1, batchSize: 1 }, async () => {
      try {
        const r = await fn(await deps());
        opts.log.info({ loop: name, result: r }, 'outreach loop ran');
        return r;
      } catch (err) {
        opts.log.warn({ loop: name, err: err instanceof Error ? err.message : String(err) }, 'outreach loop failed');
        throw err;
      }
    });
    enabled.push(name);
  }
  return enabled;
}
