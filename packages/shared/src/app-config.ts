import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError } from './errors.js';

// Optional config.yaml at the repo root: per-task LLM routing and per-plugin
// config. Secrets never go here; they stay in .env.

export const LLM_PROVIDERS = ['claude-code', 'openrouter'] as const;
export type LLMProviderName = (typeof LLM_PROVIDERS)[number];

const routeSchema = z
  .object({ provider: z.enum(LLM_PROVIDERS).optional(), model: z.string().min(1).optional() })
  .strict();
export type LLMRouteOverride = z.infer<typeof routeSchema>;

export const appConfigSchema = z
  .object({
    llm: z
      .object({
        tasks: z
          .object({
            match: routeSchema.optional(),
            tailor: routeSchema.optional(),
            outreach: routeSchema.optional(),
            extract: routeSchema.optional(),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    embeddings: z
      .object({
        model: z.string().default('Xenova/bge-small-en-v1.5'),
        /** Where model files are cached; defaults to transformers.js' own cache. */
        cacheDir: z.string().optional(),
      })
      .strict()
      .default({}),
    /** Keyed by plugin id; validated by each plugin's own configSchema at load time. */
    plugins: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  })
  .strict();
export type AppConfig = z.infer<typeof appConfigSchema>;

export function parseAppConfig(raw: unknown, source = 'config'): AppConfig {
  const parsed = appConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid ${source}:\n${issues}`);
  }
  return parsed.data;
}

/** Load config.yaml (or the given path). A missing file means all defaults. */
export function loadAppConfig(path: string | null = findUp('config.yaml')): AppConfig {
  if (!path || !existsSync(path)) return parseAppConfig({});
  return parseAppConfig(parseYaml(readFileSync(path, 'utf8')), path);
}

/** Nearest file with this name in cwd or above, or null. */
export function findUp(name: string, from = process.cwd()): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const f = join(dir, name);
    if (existsSync(f)) return f;
    if (dirname(dir) === dir) return null;
  }
}
