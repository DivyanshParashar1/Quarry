import type { AppConfig, Env, LLMClient, Logger } from '@jobforge/shared';
import type { DB } from '@jobforge/db';
import { advanceJob, expireJob, fanOutReferrals, type PluginRegistry, type SequencerDeps, type startBoss } from '@jobforge/core';
import { ntfyNotifier, runOrchestratorTick, type TickResult } from '@jobforge/orchestrator';

type PgBoss = Awaited<ReturnType<typeof startBoss>>;

// Phase 22: the orchestrator's server wiring — its pg-boss loop and the
// capabilities its ops actions may use. Nothing here sends or submits.
// Automatic code fixes are NOT wired into the running server yet: an expert's
// code_fix proposal is recorded on the incident as "automatic code fixes are
// off", and the incident escalates to you. (The gated pipeline exists in
// @jobforge/orchestrator; connecting it here needs your go-ahead.)

export interface OrchestratorWiring {
  boss: PgBoss;
  db: DB;
  log: Logger;
  env: Env;
  config: AppConfig;
  registry: PluginRegistry;
  llm: () => Promise<LLMClient>;
  enqueueFetch: (ids: string[]) => Promise<unknown>;
  sweep: () => Promise<unknown>;
  match: () => Promise<unknown>;
  apply: () => Promise<unknown>;
  deadlines: () => Promise<unknown>;
  sequencerDeps: () => Promise<SequencerDeps>;
}

const QUEUE = 'orchestrator.tick';

export async function createOrchestrator(w: OrchestratorWiring): Promise<{ run: () => Promise<TickResult> }> {
  const oc = w.config.orchestrator;
  const log = w.log.child({ component: 'orchestrator' });
  const notify = ntfyNotifier(w.env.NTFY_URL);
  const run = () =>
    runOrchestratorTick({
      db: w.db,
      log,
      config: oc,
      registry: w.registry,
      llm: async () => w.llm().catch(() => undefined),
      enqueueFetch: w.enqueueFetch,
      runStage: async (stage) => (stage === 'sweep' ? w.sweep() : stage === 'match' ? w.match() : stage === 'apply' ? w.apply() : w.deadlines()),
      advanceJob: async (jobId) => advanceJob(await w.sequencerDeps(), jobId),
      expireJob: (jobId, reason) => expireJob(w.db, jobId, reason),
      topUpReferrals: async (jobId) => fanOutReferrals((await w.sequencerDeps()).fanOutDeps, jobId),
      ...(notify ? { notify } : {}),
    });

  if (oc.enabled) {
    if (!(await w.boss.getQueue(QUEUE).catch(() => null))) await w.boss.createQueue(QUEUE, { retryLimit: 0, expireInSeconds: 3 * 60 * 60 });
    const every = oc.intervalMinutes;
    await w.boss.schedule(QUEUE, every < 60 ? `*/${every} * * * *` : `11 */${Math.max(1, Math.round(every / 60))} * * *`);
    await w.boss.work(QUEUE, { localConcurrency: 1, batchSize: 1 }, async () => {
      const r = await run();
      if (r.opened.length || r.acted.length || r.resolved.length || r.escalated.length) log.info({ orchestrator: r }, 'orchestrator pass');
      return r;
    });
  } else {
    await w.boss.unschedule(QUEUE).catch(() => {});
  }
  return { run };
}
