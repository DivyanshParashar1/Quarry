// Worker host: runs pg-boss stage workers. The Fastify API arrives with the
// review UI in Phase 2.
import { loadEnv, createLogger } from '@jobforge/shared';
import { createDb } from '@jobforge/db';
import { DomainRateLimiter, registerSourceWorker, startBoss } from '@jobforge/core';
import { createRegistry } from './plugins.js';

export async function bootstrap() {
  const env = loadEnv();
  const log = createLogger({ level: env.LOG_LEVEL });
  const { db, close } = createDb(env.DATABASE_URL);
  const registry = createRegistry();
  const boss = await startBoss(env.DATABASE_URL);
  await registerSourceWorker(boss, {
    db,
    registry,
    log,
    limiter: new DomainRateLimiter(),
    dryRun: env.MODE !== 'live',
  });
  log.info(
    { mode: env.MODE, plugins: registry.list().map((p) => p.manifest.id) },
    'jobforge workers started',
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
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
