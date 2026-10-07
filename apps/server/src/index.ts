// API + worker host: serves the dashboard API (and the built web app) and runs
// the pg-boss stage workers.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUp, loadAppConfig, loadEnv, createLogger } from '@jobforge/shared';
import { createDb } from '@jobforge/db';
import { createPageFetcher, linkedinBrowserFactory, pollLinkedInTracker, runLinkedInSendTick, DomainRateLimiter, enqueueSourceFetches, runAlertSource, registerOutreachWorkers, registerSourceWorker, runAutopilot, startBoss } from '@jobforge/core';
import { buildApi } from './api.js';
import { createRegistry } from './plugins.js';
import { createGmail, lazyAutopilotDeps, lazyLLM, lazyOutreachDeps, lazyTailorDeps } from './runtime.js';

export async function bootstrap() {
  const env = loadEnv();
  const config = loadAppConfig();
  const log = createLogger({ level: env.LOG_LEVEL });
  const { db, close } = createDb(env.DATABASE_URL);
  const registry = createRegistry(config);
  const limiter = new DomainRateLimiter();
  const boss = await startBoss(env.DATABASE_URL);
  await registerSourceWorker(boss, { db, registry, log, limiter, dryRun: env.MODE !== 'live' });

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
  if (config.autopilot.enabled && env.MODE === 'live') {
    // Hourly autopilot run; pg-boss handles exactly-once scheduling across restarts.
    await boss.schedule('autopilot.hourly', '0 * * * *');
    await boss.work('autopilot.hourly', async () => {
      try {
        const summary = await runAutopilot(await autopilotDeps());
        log.info({ summary: { considered: summary.considered, approved: summary.approved, escalated: summary.escalated, skipped: summary.skipped } }, 'autopilot.hourly run finished');
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'autopilot.hourly run failed');
      }
    });
    log.info('autopilot scheduled hourly');
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
    llm: lazyLLM({ env, config, db, log }),
    enqueueFetch: (ids) => enqueueSourceFetches(boss, ids),
    config,
    pages: () => createPageFetcher({ limiter }),
    linkedinDeps,
    linkedinEnabled: env.LINKEDIN_ENABLED,
    ...(facts ? { profileDir: dirname(facts) } : {}),
    ...(resumeManifest ? { resumeDir: dirname(resumeManifest) } : {}),
  });
  // Local, single-user tool: bind to loopback only.
  await api.listen({ port: env.PORT, host: '127.0.0.1' });
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
    await linkedinBrowser.close();
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
