import type { AppConfig, Env, LLMClient, Logger } from '@jobforge/shared';
import { recordLlmCall, type DB } from '@jobforge/db';
import { createLLMFromConfig } from '@jobforge/llm';
import { createDnsResolver, createGmailClient, type AutopilotRunDeps, type DomainRateLimiter, type OutreachDeps, type PluginRegistry, type TailorRunDeps } from '@jobforge/core';
import type { GmailHandle } from '@jobforge/plugin-sdk';

export async function createGmail(env: Env, limiter: DomainRateLimiter): Promise<GmailHandle | undefined> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) return undefined;
  return createGmailClient(
    { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET, redirectUri: env.GMAIL_REDIRECT_URI, refreshToken: env.GMAIL_REFRESH_TOKEN },
    limiter,
  );
}

/** Outreach deps built once, on first use (the LLM client and Gmail login are lazy). */
export function lazyOutreachDeps(o: {
  env: Env;
  config: AppConfig;
  db: DB;
  log: Logger;
  registry: PluginRegistry;
  limiter: DomainRateLimiter;
  gmail: GmailHandle | undefined;
}): () => Promise<OutreachDeps> {
  let cached: OutreachDeps | null = null;
  return async () =>
    (cached ??= {
      db: o.db,
      registry: o.registry,
      log: o.log,
      limiter: o.limiter,
      dryRun: o.env.MODE !== 'live',
      policy: o.config.outreach,
      dns: createDnsResolver(),
      llm: createLLMFromConfig(o.env, o.config, { log: o.log, onCall: (rec) => recordLlmCall(o.db, rec) }),
      ...(o.gmail ? { gmail: o.gmail } : {}),
    });
}

/** Tailor deps built once, on first use (needs the LLM and the Typst binary at render time). */
export function lazyTailorDeps(o: {
  env: Env;
  config: AppConfig;
  db: DB;
  log: Logger;
  registry: PluginRegistry;
  limiter: DomainRateLimiter;
}): () => Promise<TailorRunDeps> {
  let cached: TailorRunDeps | null = null;
  return async () =>
    (cached ??= {
      db: o.db,
      registry: o.registry,
      log: o.log,
      limiter: o.limiter,
      dryRun: o.env.MODE !== 'live',
      llm: createLLMFromConfig(o.env, o.config, { log: o.log, onCall: (rec) => recordLlmCall(o.db, rec) }),
    });
}

/** Autopilot deps: wraps the lazy outreach + tailor deps so the LLM/Gmail clients stay shared. */
export function lazyAutopilotDeps(o: {
  env: Env;
  config: AppConfig;
  db: DB;
  log: Logger;
  outreachDeps: () => Promise<OutreachDeps>;
  tailorDeps: () => Promise<TailorRunDeps>;
}): () => Promise<AutopilotRunDeps> {
  return async () => ({
    db: o.db,
    log: o.log,
    policy: o.config.autopilot,
    outreachPolicy: o.config.outreach,
    outreachDeps: await o.outreachDeps(),
    tailorDeps: await o.tailorDeps(),
  });
}

/** LLM client built once, on first use (shared by /api/profile/fix and /import). */
export function lazyLLM(o: { env: Env; config: AppConfig; db: DB; log: Logger }): () => Promise<LLMClient> {
  let cached: LLMClient | null = null;
  return async () =>
    (cached ??= createLLMFromConfig(o.env, o.config, { log: o.log, onCall: (rec) => recordLlmCall(o.db, rec) }));
}
