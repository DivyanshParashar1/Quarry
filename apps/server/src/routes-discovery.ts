import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig, LLMClient, Logger } from '@jobforge/shared';
import { discoveredCountSince, listRecentlyDiscovered, type DB } from '@jobforge/db';
import { COMPANY_LISTS, discoverAndSave, discoverAts, runDiscoverCompanies, type PageFetcher } from '@jobforge/core';

export interface DiscoveryRouteOptions {
  db: DB;
  log?: Logger;
  config: AppConfig['discovery'];
  /** Robots-respecting fetcher for company sites; absent = discovery unavailable. */
  pages?: () => PageFetcher;
  llm?: () => Promise<LLMClient>;
}

/** Company discovery (Phase 6/13). Only reads public pages; nothing here has an external side effect. */
export function registerDiscoveryRoutes(app: FastifyInstance, o: DiscoveryRouteOptions): void {
  const pages = (): PageFetcher => {
    if (!o.pages) throw Object.assign(new Error('discovery is not configured on this server'), { statusCode: 503 });
    return o.pages();
  };
  const log = o.log ?? (app.log as unknown as Logger);
  let running: string | null = null;

  app.post('/api/companies/discover-ats', async (req) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        domain: z.string().trim().min(3).max(200).optional(),
        save: z.boolean().default(false),
        probe: z.boolean().default(true),
      })
      .strict()
      .refine((x) => x.name || x.domain, 'name or domain is required')
      .refine((x) => !x.save || x.name, 'save needs a company name')
      .parse(req.body ?? {});
    const input = { ...(b.name ? { name: b.name } : {}), ...(b.domain ? { domain: b.domain } : {}) };
    if (b.save) {
      return discoverAndSave(
        { db: o.db, pages: pages(), log },
        { ...input, name: b.name!, discoveredVia: 'discover_ats' },
        { probe: b.probe, minConfidence: o.config.minConfidence },
      );
    }
    return discoverAts({ pages: pages(), log }, input, { probe: b.probe });
  });

  app.post('/api/discovery/run', async (req, reply) => {
    const b = z
      .object({
        list: z.enum(Object.keys(COMPANY_LISTS) as [string, ...string[]]),
        maxNew: z.number().int().positive().max(1000).optional(),
        dryRun: z.boolean().default(false),
      })
      .strict()
      .parse(req.body ?? {});
    if (running) return reply.status(409).send({ error: 'busy', message: `discovery of ${running} is already running` });
    const p = pages();
    const settings = o.config.lists[b.list];
    const llm = COMPANY_LISTS[b.list]!.needsLlm && o.llm ? await o.llm() : undefined;
    running = b.list;
    // Crawls take minutes; run in the background. The result lands in plugin_runs + events.
    void runDiscoverCompanies(
      { db: o.db, pages: p, llm, log },
      {
        list: b.list,
        settings: { urls: settings?.urls, regions: settings?.regions },
        maxNew: b.maxNew ?? settings?.maxNew ?? 100,
        minConfidence: o.config.minConfidence,
        dryRun: b.dryRun,
      },
    )
      .then((s) => log.info({ list: s.list, added: s.added, withAts: s.withAts, errors: s.errors.length }, 'discovery run finished'))
      .catch((err: unknown) => log.error({ err: err instanceof Error ? err.message : String(err) }, 'discovery run failed'))
      .finally(() => {
        running = null;
      });
    return reply.status(202).send({ started: b.list });
  });

  app.get('/api/companies/discovered', async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
    const since = new Date(Date.now() - q.days * 24 * 3600_000);
    const today = await discoveredCountSince(o.db, new Date(Date.now() - 24 * 3600_000));
    return {
      days: q.days,
      companies: await listRecentlyDiscovered(o.db, since),
      lastDay: today,
      alertThreshold: o.config.alertThreshold,
      alert: today > o.config.alertThreshold,
      running,
    };
  });
}
