import type { AppConfig, Env, Logger } from '@jobforge/shared';
import { recordLlmCall, type DB } from '@jobforge/db';
import { createLLMFromConfig } from '@jobforge/llm';
import { createLocalEmbedder } from '@jobforge/embeddings';
import { createDnsResolver, createGmailClient, DomainRateLimiter, type OutreachDeps, type TailorRunDeps } from '@jobforge/core';
import type { GmailHandle } from '@jobforge/plugin-sdk';
import { createRegistry } from './plugins.js';

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

/** The user's Gmail, or undefined when `jf gmail auth` hasn't been run. */
export async function createGmail(env: Env, limiter: DomainRateLimiter): Promise<GmailHandle | undefined> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) return undefined;
  return createGmailClient(
    {
      clientId: env.GMAIL_CLIENT_ID,
      clientSecret: env.GMAIL_CLIENT_SECRET,
      redirectUri: env.GMAIL_REDIRECT_URI,
      refreshToken: env.GMAIL_REFRESH_TOKEN,
    },
    limiter,
  );
}

/**
 * Everything the outreach engine needs. dryRun stays true unless the caller
 * passes live=true (from --live) or MODE=live (PLAN.md §9).
 */
export async function outreachDeps(
  o: { env: Env; config: AppConfig; db: DB; log: Logger; live?: boolean; gmail?: boolean; llm?: boolean },
): Promise<OutreachDeps> {
  const limiter = new DomainRateLimiter();
  const gmail = o.gmail ? await createGmail(o.env, limiter) : undefined;
  return {
    db: o.db,
    registry: createRegistry(o.config),
    log: o.log,
    limiter,
    dryRun: !(o.live || o.env.MODE === 'live'),
    policy: o.config.outreach,
    dns: createDnsResolver(),
    ...(o.llm ? { llm: createLLM(o.env, o.config, o.db, o.log) } : {}),
    ...(gmail ? { gmail } : {}),
  };
}

/** Tailor deps for the CLI: shares the LLM client with the rest of the pipeline. */
export function tailorDeps(
  o: { env: Env; config: AppConfig; db: DB; log: Logger; live?: boolean },
): TailorRunDeps {
  return {
    db: o.db,
    registry: createRegistry(o.config),
    log: o.log,
    limiter: new DomainRateLimiter(),
    dryRun: !(o.live || o.env.MODE === 'live'),
    llm: createLLM(o.env, o.config, o.db, o.log),
  };
}
