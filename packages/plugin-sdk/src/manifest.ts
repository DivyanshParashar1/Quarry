import { z } from 'zod';

export const stageEnum = z.enum(['source', 'enricher', 'matcher', 'tailor', 'actor', 'tracker']);
export type Stage = z.infer<typeof stageEnum>;

// Exact hostnames (no scheme, port or path), or a leading-label wildcard
// `*.example.com` that matches any subdomain of example.com (never example.com
// itself). Wildcards exist for multi-tenant ATS hosts such as
// `acme.wd5.myworkdayjobs.com`; the suffix must still have at least two labels.
const hostname = z
  .string()
  .regex(
    /^(\*\.)?(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/,
    'must be an exact lowercase hostname or a *.suffix wildcard',
  );

/** True when `host` is allowed by an exact entry or a `*.suffix` wildcard entry. */
export function hostAllowed(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase();
  for (const d of domains) {
    if (d.startsWith('*.')) {
      if (h.endsWith(d.slice(1)) && h.length > d.length - 1) return true;
    } else if (d === h) return true;
  }
  return false;
}

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
      /** MX lookups (no SMTP). */
      dns: z.boolean().optional(),
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
