// Fastify API + pg-boss workers — implemented in Phase 1+.
import { loadEnv, createLogger } from '@jobforge/shared';

export async function bootstrap() {
  const env = loadEnv();
  const log = createLogger({ level: env.LOG_LEVEL });
  log.info({ mode: env.MODE, provider: env.LLM_PROVIDER }, 'jobforge server (scaffold)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
