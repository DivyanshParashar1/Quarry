import { z } from 'zod';

export const stageEnum = z.enum(['source', 'enricher', 'matcher', 'tailor', 'actor', 'tracker']);
export type Stage = z.infer<typeof stageEnum>;

// Exact hostnames only (no scheme, port, path, or wildcard). ScopedHttp matches on these verbatim.
const hostname = z
  .string()
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'must be an exact lowercase hostname, no wildcards');

export const pluginManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case'),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/, 'must be semver'),
    stage: stageEnum,
    description: z.string(),
    configSchema: z.custom<z.ZodTypeAny>((v) => v instanceof z.ZodType, 'must be a zod schema'),
    permissions: z.object({
      domains: z.array(hostname),
      llm: z.boolean().optional(),
      browser: z.boolean().optional(),
      gmail: z.array(z.enum(['read', 'send'])).optional(),
    }),
    rateLimit: z
      .object({
        perDomain: z.object({
          tokens: z.number().int().positive(),
          intervalMs: z.number().int().positive(),
        }),
      })
      .optional(),
    sideEffects: z.enum(['none', 'external']),
  })
  .superRefine((m, ctx) => {
    if (m.stage === 'actor' && m.sideEffects !== 'external') {
      ctx.addIssue({ code: 'custom', path: ['sideEffects'], message: 'actors must declare sideEffects: "external"' });
    }
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
