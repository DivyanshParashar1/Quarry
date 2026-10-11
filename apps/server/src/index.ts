// API + worker host: serves the dashboard API (and the built web app) and runs
// the pg-boss stage workers.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUp, loadAppConfig, loadEnv, createLogger } from '@jobforge/shared';
import { createDb } from '@jobforge/db';
import { createPageFetcher, embedPending, handleStageEvent, runMatch, runSweep, setStageSink, type StageEvent, importLinkedInEmployees, runAtsRecheck, runNightlyDiscovery, launchBrowser, runApplyTick, linkedinBrowserFactory, pollLinkedInTracker, runDeadlines, runLinkedInSendTick, DomainRateLimiter, enqueueSourceFetches, runAlertSource, registerOutreachWorkers, registerSourceWorker, runAutopilot, startBoss } from '@jobforge/core';
import { buildApi } from './api.js';
import { createRegistry } from '@jobforge/plugins';
import { createLazyEmbedder } from '@jobforge/embeddings';
import { createGmail, lazyAutopilotDeps, lazyLLM, lazyOutreachDeps, lazyTailorDeps } from './runtime.js';
import { createOrchestrator } from './orchestrator.js';
import { ChatRunner } from './chat-runner.js';
import { homedir } from 'node:os';

export async function bootstrap() {
  const env = loadEnv();
  const config = loadAppConfig();
  const log = createLogger({ level: env.LOG_LEVEL });
  const { db, close } = createDb(env.DATABASE_URL);
  const registry = createRegistry(config);
  const limiter = new DomainRateLimiter();
  const boss = await startBoss(env.DATABASE_URL);
  await registerSourceWorker(boss, { db, registry, log, limiter, dryRun: env.MODE !== 'live' });
  // Phase 22: failures queue an early orchestrator pass (one at a time; the 15-minute schedule covers the rest).
  const triggerOrchestrator = async (why: string) => {
    if (!config.orchestrator.enabled) return;
    await boss.send('orchestrator.tick', { why }, { singletonKey: 'orchestrator', singletonSeconds: 300 }).catch(() => null);
  };

  const gmail = await createGmail(env, limiter).catch((err: unknown) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Gmail login failed; outreach loops disabled');
    return undefined;
  });
  const outreachDeps = lazyOutreachDeps({ env, config, db, log, registry, limiter, gmail });
  const tailorDeps = lazyTailorDeps({ env, config, db, log, registry, limiter });
  const autopilotDeps = lazyAutopilotDeps({ env, config, db, log, outreachDeps, tailorDeps });
  const loops = await registerOutreachWorkers(boss, outreachDeps, { live: env.MODE === 'live', gmailConnected: !!gmail, log });
  if (gmail) {
    // Job-alert emails (Phase 7): read-only, so it runs in dev mode too.
    if (!(await boss.getQueue('source.alerts').catch(() => null))) await boss.createQueue('source.alerts', { retryLimit: 0, expireInSeconds: 10 * 60 });
    await boss.schedule('source.alerts', '*/30 * * * *');
    await boss.work('source.alerts', { localConcurrency: 1, batchSize: 1 }, async () => {
      const s = await runAlertSource({ db, registry, log, limiter, dryRun: env.MODE !== 'live', gmail });
      log.info({ alerts: s }, 'job-alert poll finished');
      return s;
    });
  }
  const ws = findUp('pnpm-workspace.yaml');
  const linkedinBrowser = linkedinBrowserFactory(env, ws ? dirname(ws) : process.cwd());
  const linkedinDeps = async () => ({
    db,
    registry,
    log,
    limiter,
    dryRun: env.MODE !== 'live',
    linkedin: config.linkedin,
    enabled: env.LINKEDIN_ENABLED && env.MODE === 'live',
    openBrowser: linkedinBrowser.open,
  });

  if (env.LINKEDIN_ENABLED && env.MODE === 'live') {
    // Phase 9 loops: one connection request per minute at most (the loop's own
    // random gap and daily cap apply), tracking every 30 minutes.
    const loops: [string, string, () => Promise<unknown>][] = [
      ['linkedin.send', '* * * * *', async () => runLinkedInSendTick({ ...(await linkedinDeps()), policy: config.outreach, saveSession: linkedinBrowser.save })],
      ['linkedin.track', '*/30 * * * *', async () => pollLinkedInTracker({ ...(await linkedinDeps()), saveSession: linkedinBrowser.save })],
    ];
    for (const [name, cron, fn] of loops) {
      if (!(await boss.getQueue(name).catch(() => null))) await boss.createQueue(name, { retryLimit: 0, expireInSeconds: 15 * 60 });
      await boss.schedule(name, cron);
      await boss.work(name, { localConcurrency: 1, batchSize: 1 }, async () => {
        const r = await fn();
        log.info({ loop: name, result: r }, 'linkedin loop ran');
        return r;
      });
    }
  } else {
    for (const name of ['linkedin.send', 'linkedin.track']) await boss.unschedule(name).catch(() => {});
  }

  const llmLazy = lazyLLM({ env, config, db, log });
  const deadlineDeps = async () => ({ db, registry, log, limiter, dryRun: env.MODE !== 'live', llm: await llmLazy(), policy: config.deadlines });
  if (config.deadlines.nightly) {
    if (!(await boss.getQueue('deadlines.nightly').catch(() => null))) await boss.createQueue('deadlines.nightly', { retryLimit: 0, expireInSeconds: 60 * 60 });
    await boss.schedule('deadlines.nightly', '23 2 * * *');
    await boss.work('deadlines.nightly', { localConcurrency: 1, batchSize: 1 }, async () => {
      const r = await runDeadlines(await deadlineDeps());
      log.info({ deadlines: { estimated: r.estimated, expired: r.expired.length, failed: r.failed.length } }, 'deadline run finished');
      return r;
    });
  }

  // Phase 11: a plain browser (not the LinkedIn session) for application forms.
  let applyBrowser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  const applyDeps = async () => ({
    ...(await outreachDeps()),
    openBrowser: async () => (applyBrowser ??= await launchBrowser({ headless: env.BROWSER_HEADLESS })),
  });
  if (env.MODE === 'live') {
    if (!(await boss.getQueue('apply.send').catch(() => null))) await boss.createQueue('apply.send', { retryLimit: 0, expireInSeconds: 20 * 60 });
    await boss.schedule('apply.send', '*/5 * * * *');
    await boss.work('apply.send', { localConcurrency: 1, batchSize: 1 }, async () => {
      const r = await runApplyTick(await applyDeps());
      if (r.outcomes.length) log.info({ apply: r }, 'apply loop ran');
      if (r.outcomes.some((x) => !x.ok)) await triggerOrchestrator('apply failure');
      return r;
    });
  } else {
    await boss.unschedule('apply.send').catch(() => {});
  }

  // Phase 12: the referral-first sequencer (default autopilot strategy).
  const sequencerDeps = async () => {
    const li = await linkedinDeps();
    const out = await outreachDeps();
    return {
      db,
      log,
      policy: config.autopilot,
      outreachPolicy: config.outreach,
      fanOutDeps: {
        ...out,
        ...(li.enabled
          ? { findMoreContacts: async (companyId: string, _jobId: string, wanted: number) => (await importLinkedInEmployees(li, companyId, { maxProfiles: Math.max(wanted * 2, config.linkedin.profilesPerCompany) })).contactsCreated }
          : {}),
      },
      tailorDeps: await tailorDeps(),
      applyDeps: await applyDeps(),
    };
  };
  // Phase 18: the sweeper replaces autopilot.hourly. Free steps (board fetch, alerts, reply
  // tracking, deadline expiry) always run; LLM steps only with autopilot.enabled; sends need MODE=live.
  const embedder = createLazyEmbedder({ model: config.embeddings.model, ...(config.embeddings.cacheDir ? { cacheDir: config.embeddings.cacheDir } : {}) });
  const match = async (jobIds?: string[]) => {
    const e = await embedPending({ db, embedder, log });
    const m = await runMatch({ db, registry, log, limiter, dryRun: env.MODE !== 'live', llm: await llmLazy(), embed: embedder }, { limit: config.sweeper.matchLimit, ...(jobIds ? { jobIds } : {}) });
    return { embedded: e.jobs, llm: m.llm, prefilter: m.prefilter, filtered: m.filtered, unscored: m.unscored };
  };
  const sweepDeps = {
    db,
    log,
    config,
    live: env.MODE === 'live',
    gmailConnected: !!gmail,
    enqueueFetch: (ids: string[]) => enqueueSourceFetches(boss, ids),
    ...(gmail ? { alerts: () => runAlertSource({ db, registry, log, limiter, dryRun: env.MODE !== 'live', gmail }) } : {}),
    outreach: outreachDeps,
    match,
    sequencer: sequencerDeps,
    singleEmail: async () => runAutopilot(await autopilotDeps()),
    deadlines: deadlineDeps,
    apply: applyDeps,
  };
  if (!(await boss.getQueue('sweeper.hourly').catch(() => null))) await boss.createQueue('sweeper.hourly', { retryLimit: 0, expireInSeconds: 2 * 60 * 60 });
  await boss.unschedule('autopilot.hourly').catch(() => {});
  await boss.schedule('sweeper.hourly', '7 * * * *');
  await boss.work('sweeper.hourly', { localConcurrency: 1, batchSize: 1 }, async () => {
    const r = await runSweep(sweepDeps);
    log.info({ sweep: r.skipped ?? r.steps.map((s) => `${s.name}:${s.skipped ? 'skip' : s.ok ? 'ok' : 'FAIL'}`).join(' ') }, 'sweeper ran');
    return r;
  });

  // Phase 18 event triggers: a finished stage queues the next one right away (autopilot only:
  // every handler spends LLM calls). The hourly sweep re-derives anything a lost trigger missed.
  if (config.autopilot.enabled) {
    if (!(await boss.getQueue('stage.event').catch(() => null))) await boss.createQueue('stage.event', { retryLimit: 2, retryDelay: 60, expireInSeconds: 30 * 60 });
    await boss.work<StageEvent>('stage.event', { localConcurrency: 1, batchSize: 1 }, async ([job]) => {
      await handleStageEvent({ db, log, match: (ids) => match(ids), sequencer: sequencerDeps }, job!.data);
    });
    setStageSink(async (e) => {
      await boss.send('stage.event', e);
    });
  } else {
    setStageSink(null);
  }

  if (config.discovery.nightly) {
    // Phase 13: crawl company lists nightly and re-check ATSs daily (each company monthly).
    // Read-only public pages, so it runs in dev mode too.
    const pages = () => createPageFetcher({ limiter });
    const enqueueFetch = (ids: string[]) => enqueueSourceFetches(boss, ids);
    const loops: [string, string, () => Promise<unknown>][] = [
      ['discovery.nightly', '41 3 * * *', async () => runNightlyDiscovery({ db, pages: pages(), llm: await llmLazy().catch(() => undefined), log, enqueueFetch }, config.discovery)],
      ['discovery.recheck', '13 4 * * *', async () => runAtsRecheck({ db, pages: pages(), log, enqueueFetch }, config.discovery)],
    ];
    for (const [name, cron, fn] of loops) {
      if (!(await boss.getQueue(name).catch(() => null))) await boss.createQueue(name, { retryLimit: 0, expireInSeconds: 3 * 60 * 60 });
      await boss.schedule(name, cron);
      await boss.work(name, { localConcurrency: 1, batchSize: 1 }, async () => {
        const r = await fn();
        log.info({ loop: name, result: r }, 'discovery loop ran');
        return r;
      });
    }
  } else {
    for (const name of ['discovery.nightly', 'discovery.recheck']) await boss.unschedule(name).catch(() => {});
  }

  // Phase 22: the orchestrator — monitor every intervalMinutes and after failures; ops actions only
  // (automatic code fixes are not wired into the server; see orchestrator.ts).
  const orchestrator = await createOrchestrator({
    boss,
    db,
    log,
    env,
    config,
    registry,
    llm: llmLazy,
    enqueueFetch: (ids: string[]) => enqueueSourceFetches(boss, ids),
    sweep: () => runSweep(sweepDeps, { reason: 'orchestrator' }),
    match: () => match(),
    apply: async () => runApplyTick(await applyDeps()),
    deadlines: async () => runDeadlines(await deadlineDeps()),
    sequencerDeps,
  });

  // The chatbot: Claude Code with the product's MCP tools, the web and scripts; code changes gated + merged.
  let chat: ChatRunner | undefined;
  if (config.chat.enabled) {
    chat = new ChatRunner({
      db,
      log: log.child({ component: 'chat' }),
      repoDir: ws ? dirname(ws) : process.cwd(),
      worktreeRoot: join(homedir(), '.jobforge', 'chat'),
      apiUrl: `http://127.0.0.1:${env.PORT}`,
      claude: { command: env.CLAUDE_CLI_PATH, ...(config.chat.model ? { model: config.chat.model } : {}), timeoutMs: config.chat.timeoutMin * 60_000 },
      setup: config.chat.setup,
      gates: config.chat.gates,
      mergeCodeChanges: config.chat.mergeCodeChanges,
      maxConcurrent: config.chat.maxConcurrent,
    });
    await chat.recover();
  }

  const facts = findUp('profile/facts.yaml');
  const resumeManifest = findUp('profile/resume/manifest.yaml');
  const api = await buildApi({
    db,
    log,
    webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
    policy: config.outreach,
    outreachDeps,
    tailorDeps,
    autopilotDeps,
    llm: llmLazy,
    deadlineDeps,
    applyDeps,
    sequencerDeps,
    screenshotRoot: join(ws ? dirname(ws) : process.cwd(), 'data', 'screenshots'),
    failureRoot: join(ws ? dirname(ws) : process.cwd(), 'data', 'apply-failures'),
    enqueueFetch: (ids) => enqueueSourceFetches(boss, ids),
    config,
    pages: () => createPageFetcher({ limiter }),
    linkedinDeps,
    linkedinEnabled: env.LINKEDIN_ENABLED,
    sweep: () => runSweep(sweepDeps, { reason: 'dashboard' }),
    runOrchestrator: orchestrator.run,
    ...(chat ? { chat } : {}),
    ...(facts ? { profileDir: dirname(facts) } : {}),
    ...(resumeManifest ? { resumeDir: dirname(resumeManifest) } : {}),
  });
  // Local, single-user tool: bind to loopback only.
  await api.listen({ port: env.PORT, host: '127.0.0.1' });
  if (config.sweeper.runOnStart) {
    // Catch up on whatever came due while the server was off (doesn't block startup).
    void runSweep(sweepDeps, { reason: 'server start' })
      .then((r) => log.info({ sweep: r.skipped ?? r.steps.map((s) => `${s.name}:${s.skipped ? 'skip' : s.ok ? 'ok' : 'FAIL'}`).join(' ') }, 'startup sweep finished'))
      .catch((err: unknown) => log.error({ err: err instanceof Error ? err.message : String(err) }, 'startup sweep failed'));
  }
  log.info(
    {
      mode: env.MODE,
      url: `http://localhost:${env.PORT}`,
      gmail: gmail?.address ?? null,
      outreachLoops: loops,
      plugins: registry.list().map((p) => p.manifest.id),
    },
    'jobforge server started',
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    await api.close();
    setStageSink(null);
    await linkedinBrowser.close();
    await applyBrowser?.close?.();
    await boss.stop({ graceful: true, timeout: 30_000 });
    await close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
