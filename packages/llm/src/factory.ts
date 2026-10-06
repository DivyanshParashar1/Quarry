import type { AppConfig, Env, LLMProviderName, Logger } from '@jobforge/shared';
import { createClaudeCodeProvider } from './claude-code.js';
import { createLLMClient, type LLMCallRecord } from './client.js';
import { createOpenRouterProvider } from './openrouter.js';
import type { LLMProvider } from './provider.js';

/**
 * Build the configured client: LLM_PROVIDER from .env as the default,
 * per-task overrides from config.yaml. Only providers that some task routes
 * to are constructed, so OpenRouter needs no key while it's unused.
 */
export function createLLMFromConfig(
  env: Env,
  config: AppConfig,
  hooks: { onCall?: (rec: LLMCallRecord) => void | Promise<void>; log?: Logger } = {},
) {
  const needed = new Set<LLMProviderName>([env.LLM_PROVIDER]);
  for (const o of Object.values(config.llm.tasks)) if (o?.provider) needed.add(o.provider);

  const providers: Partial<Record<LLMProviderName, LLMProvider>> = {};
  if (needed.has('claude-code')) {
    providers['claude-code'] = createClaudeCodeProvider({
      cliPath: env.CLAUDE_CLI_PATH,
      defaultModel: env.CLAUDE_DEFAULT_MODEL,
      concurrency: env.CLAUDE_CONCURRENCY,
      timeoutMs: env.CLAUDE_TIMEOUT_MS,
    });
  }
  if (needed.has('openrouter')) {
    providers.openrouter = createOpenRouterProvider({
      apiKey: env.OPENROUTER_API_KEY ?? '',
      baseUrl: env.OPENROUTER_BASE_URL,
      defaultModel: env.OPENROUTER_DEFAULT_MODEL,
      concurrency: env.OPENROUTER_CONCURRENCY,
      timeoutMs: env.OPENROUTER_TIMEOUT_MS,
    });
  }
  return createLLMClient({
    providers,
    defaultProvider: env.LLM_PROVIDER,
    tasks: config.llm.tasks,
    ...(hooks.onCall ? { onCall: hooks.onCall } : {}),
    ...(hooks.log ? { log: hooks.log } : {}),
  });
}
