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
            research: routeSchema.optional(),
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
    /**
     * Outreach policy. PLAN-phases-6-13 (user-approved): no global daily cap and
     * no per-company weekly cap by default; the product throttles are the
     * per-contact cooldown and the per-job referral cap, plus the sender's own
     * technical limit. Setting dailyCap / perCompanyPerWeek re-enables those caps.
     */
    outreach: z
      .object({
        /** Optional product cap on real emails per rolling 24h. null = no cap. */
        dailyCap: z.number().int().min(0).nullable().default(null),
        /** Optional cap on distinct people emailed at one company per 7 days. null = no cap. */
        perCompanyPerWeek: z.number().int().min(1).nullable().default(null),
        /** Technical sender limit (Gmail allows ~500/day on consumer accounts); not a product cap. */
        senderDailyLimit: z.number().int().min(1).default(400),
        /** Default number of referral asks per job (a batch can override it). */
        perJobReferralCap: z.number().int().min(1).max(100).default(10),
        /** A person is never asked twice within this many days, across all jobs and channels. */
        perContactCooldownDays: z.number().int().min(0).default(30),
        /** Below this email confidence a contact is asked on LinkedIn instead (if they have a profile). */
        referralMinEmailConfidence: z.number().min(0).max(1).default(0.3),
        /** Random gap between two real sends, in minutes [min, max]. */
        spacingMinutes: z
          .tuple([z.number().min(0), z.number().min(0)])
          .default([4, 11])
          .refine(([a, b]) => a <= b, 'min must be <= max'),
        /** Days to wait before follow-up 1, 2, ... (length caps the number of follow-ups). */
        followupDays: z.array(z.number().positive()).max(5).default([5, 7]),
        /** Hard ceiling on follow-ups per thread (PLAN.md §8: up to 2). */
        maxFollowups: z.number().int().min(0).max(5).default(2),
      })
      .strict()
      .default({}),
    /** Headline shown on tailored resumes (name, contact line, headline). Never auto-invented. */
    resume: z
      .object({
        name: z.string().default(''),
        contact: z.string().default(''),
        headline: z.string().default(''),
      })
      .strict()
      .default({}),
    /** Autopilot: LLM-in-the-loop runner. Only confused items (below the floors) escalate to review. */
    autopilot: z
      .object({
        enabled: z.boolean().default(false),
        /** Min overall match score; below this the autopilot ignores the job. */
        minMatchScore: z.number().int().min(0).max(100).default(70),
        /** Per-stage self-reported confidence floors; failing any one escalates (pending in review). */
        confidenceFloor: z
          .object({
            match: z.number().min(0).max(1).default(0.75),
            tailor: z.number().min(0).max(1).default(0.75),
            outreach: z.number().min(0).max(1).default(0.8),
          })
          .strict()
          .default({}),
        /** Min contact.email_confidence before the autopilot will auto-approve to that address. */
        minEmailConfidence: z.number().min(0).max(1).default(0.6),
        /** Max review items the autopilot may auto-approve per rolling 24h. */
        maxAutoApprovesPerDay: z.number().int().min(0).max(100).default(10),
        /** How many top-ranked candidates to walk per run. */
        candidateBatch: z.number().int().min(1).max(100).default(20),
      })
      .strict()
      .default({}),
    /** Deadline inference (Phase 10). Each estimate is one web-searching LLM call. */
    deadlines: z
      .object({
        /** Only jobs the matcher scored at least this high get an estimate. */
        minMatchScore: z.number().int().min(0).max(100).default(60),
        /** Re-estimate after this many days. */
        staleDays: z.number().int().min(1).default(14),
        /** Max estimates per run. */
        batchSize: z.number().int().min(1).max(200).default(20),
        /** A passed deadline closes the job only at or above this confidence… */
        expireMinConfidence: z.number().min(0).max(1).default(0.6),
        /** …and only this many days after the date. */
        expireGraceDays: z.number().int().min(0).default(1),
        /** Server: run the estimator daily (costs LLM calls). */
        nightly: z.boolean().default(false),
      })
      .strict()
      .default({}),
    /** LinkedIn (Phase 8/9). Also gated by LINKEDIN_ENABLED=true and a live run. */
    linkedin: z
      .object({
        /** Technical safeguard for a new account (LinkedIn's soft limit); not a product cap. */
        dailyConnectionCap: z.number().int().min(1).max(100).default(25),
        /** Minimum gap between two people searches. */
        searchIntervalSeconds: z.number().int().min(10).default(60),
        /** Random pause between actions, seconds [min, max]. */
        actionGapSeconds: z
          .tuple([z.number().min(0), z.number().min(0)])
          .default([45, 120])
          .refine(([a, b]) => a <= b, 'min must be <= max'),
        /** First cool-down after a warning/captcha page; doubles on each repeat. */
        cooldownMinutes: z.number().int().min(1).default(60),
        /** People-search title keywords for referral candidates. */
        searchKeywords: z.array(z.string()).default(['software engineer', 'SDE', 'developer']),
        /** Profiles to collect per company per run. */
        profilesPerCompany: z.number().int().min(1).max(50).default(15),
      })
      .strict()
      .default({}),
    /** Company discovery (Phase 6/13): list crawlers + discover_ats. */
    discovery: z
      .object({
        /** Detections below this confidence are reported but not saved as boards. */
        minConfidence: z.number().min(0).max(1).default(0.5),
        /** Per-list settings, keyed by list id (yc, gcc-journal, wellfound, internshala, hirect). */
        lists: z
          .record(
            z.string(),
            z
              .object({
                enabled: z.boolean().default(true),
                /** Pages to crawl (LLM-extracted lists) or the JSON feed (yc). */
                urls: z.array(z.string().url()).optional(),
                /** yc: keep companies whose regions include one of these. */
                regions: z.array(z.string()).optional(),
                /** Max new companies per run from this list. */
                maxNew: z.number().int().positive().optional(),
              })
              .strict(),
          )
          .default({}),
        /** Phase 13: show a dashboard banner when one day adds more than this many companies. */
        alertThreshold: z.number().int().positive().default(40),
        /** Phase 13: re-check each company's ATS this often. */
        recheckDays: z.number().int().positive().default(30),
        /** Phase 13: run the nightly discovery loop (server, MODE=live not required: it only reads public pages). */
        nightly: z.boolean().default(false),
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
