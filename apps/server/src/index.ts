// API + worker host: serves the dashboard API (and the built web app) and runs
// the pg-boss stage workers.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUp, loadAppConfig, loadEnv, createLogger } from '@jobforge/shared';
import { createDb } from '@jobforge/db';
import { DomainRateLimiter, enqueueSourceFetches, registerOutreachWorkers, registerSourceWorker, runAutopilot, startBoss } from '@jobforge/core';
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
