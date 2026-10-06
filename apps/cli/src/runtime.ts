import type { AppConfig, Env, Logger } from '@jobforge/shared';
import { recordLlmCall, type DB } from '@jobforge/db';
import { createLLMFromConfig } from '@jobforge/llm';
import { createLocalEmbedder } from '@jobforge/embeddings';

/** The configured LLM client; every call is logged to llm_calls. */
export function createLLM(env: Env, config: AppConfig, db: DB, log: Logger) {
  return createLLMFromConfig(env, config, { log, onCall: (rec) => recordLlmCall(db, rec) });
}

export function createEmbedder(config: AppConfig) {
  return createLocalEmbedder({
    model: config.embeddings.model,
    ...(config.embeddings.cacheDir ? { cacheDir: config.embeddings.cacheDir } : {}),
  });
}
