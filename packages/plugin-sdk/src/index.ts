import { z } from 'zod';

// Scaffold stub for Phase 1. The full plugin contract (see PLAN.md section 4) is
// implemented in Phase 1 alongside the plugin loader. This file exists so that
// workspace linking and import paths are stable from the start.

export const stageEnum = z.enum([
  'source',
  'enricher',
  'matcher',
  'tailor',
  'actor',
  'tracker',
]);
export type Stage = z.infer<typeof stageEnum>;

export const pluginManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  stage: stageEnum,
  description: z.string(),
  configSchema: z.custom<z.ZodTypeAny>((v) => v instanceof z.ZodType),
  permissions: z.object({
    domains: z.array(z.string()),
    llm: z.boolean().optional(),
    browser: z.boolean().optional(),
    gmail: z.array(z.enum(['read', 'send'])).optional(),
  }),
  rateLimit: z
    .object({
      perDomain: z.object({ tokens: z.number().int().positive(), intervalMs: z.number().int().positive() }),
    })
    .optional(),
  sideEffects: z.enum(['none', 'external']),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
