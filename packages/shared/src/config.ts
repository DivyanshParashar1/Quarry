import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  MODE: z.enum(['dev', 'live']).default('dev'),

  LLM_PROVIDER: z.enum(['claude-code', 'openrouter']).default('claude-code'),

  CLAUDE_CLI_PATH: z.string().default('claude'),
  CLAUDE_DEFAULT_MODEL: z.string().default('claude-sonnet-4-6'),
  CLAUDE_CONCURRENCY: z.coerce.number().int().positive().default(2),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_DEFAULT_MODEL: z.string().default('anthropic/claude-sonnet-4'),

  OPENROUTER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REDIRECT_URI: z.string().url().default('http://127.0.0.1:53682/oauth2callback'),
  /** Written by `jf gmail auth`. Never logged. */
  GMAIL_REFRESH_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
