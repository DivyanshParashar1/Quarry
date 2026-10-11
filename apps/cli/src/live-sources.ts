// Phase 23 (read-only): run every source plugin once against a real public board
// and report what parsed. GETs (and Taleo's search POST) only, through the same
// scoped HTTP + per-domain rate limits the server uses. Nothing is written to the DB.
//   pnpm live:sources [--save <dir>]   (--save keeps the first postings as JSON for fixture refreshes)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rawPostingSchema, type SourcePlugin, type SourceTarget } from '@jobforge/plugin-sdk';
import { buildContext, createScopedHttp, DomainRateLimiter } from '@jobforge/core';
import { createRegistry } from '@jobforge/plugins';
import { createLogger, loadAppConfig } from '@jobforge/shared';

const TARGETS: Array<{ plugin: string; company: string; token: string; options?: Record<string, unknown> }> = [
  { plugin: 'source-greenhouse', company: 'Airbnb', token: 'airbnb' },
  { plugin: 'source-lever', company: 'Spotify', token: 'spotify' },
  { plugin: 'source-ashby', company: 'Linear', token: 'linear' },
  { plugin: 'source-smartrecruiters', company: 'Bosch Group', token: 'BoschGroup' },
  { plugin: 'source-workday', company: 'Workday', token: 'workday.wd5/Workday', options: { searchText: 'engineer', maxPostings: 5 } },
  { plugin: 'source-workday', company: 'Wells Fargo', token: 'wd1.myworkdaysite.com/wf/WellsFargoJobs', options: { searchText: 'engineer', maxPostings: 5 } },
  { plugin: 'source-taleo', company: 'American Airlines', token: 'aa224/ex' },
];
const MAX = 40;

const save = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : undefined;
const log = createLogger({ level: 'warn' });
const registry = createRegistry(loadAppConfig());
const limiter = new DomainRateLimiter();
let failed = 0;

for (const t of TARGETS) {
  const loaded = registry.source(t.plugin);
  const ctx = buildContext(loaded, { limiter, log, signal: AbortSignal.timeout(180_000), dryRun: true });
  const target: SourceTarget = { companySourceId: 'live', companyId: 'live', companyName: t.company, boardToken: t.token, ...(t.options ? { options: t.options } : {}) };
  const started = Date.now();
  let n = 0;
  let invalid = 0;
  let withDesc = 0;
  let withLoc = 0;
  const sample: unknown[] = [];
  try {
    for await (const item of (loaded.plugin as SourcePlugin).fetch(ctx, target)) {
      n++;
      const p = rawPostingSchema.safeParse(item);
      if (!p.success) invalid++;
      else {
        if (p.data.descriptionHtml) withDesc++;
        if (p.data.locations.length) withLoc++;
        if (sample.length < 3) sample.push({ ...p.data, payload: undefined, descriptionHtml: p.data.descriptionHtml?.slice(0, 300) ?? null });
      }
      if (n >= MAX) break;
    }
    const ok = n > 0 && invalid === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${t.plugin.padEnd(24)} ${t.token.padEnd(42)} ${String(n).padStart(3)} postings${n >= MAX ? '+' : ''} · ${invalid} invalid · ${withDesc} with description · ${withLoc} with location · ${Date.now() - started} ms`);
    if (save && sample.length) {
      mkdirSync(save, { recursive: true });
      writeFileSync(join(save, `${t.plugin}-${t.token.replace(/[^a-z0-9]+/gi, '_')}.json`), JSON.stringify(sample, null, 2));
    }
  } catch (err) {
    failed++;
    console.log(`FAIL ${t.plugin.padEnd(24)} ${t.token.padEnd(42)} ${(err as Error).message.slice(0, 200)}`);
  }
}

// SuccessFactors RMK sites mostly live on the employer's own domain, which the
// source plugin can't reach; check the parser against one directly.
{
  const { parseRmkSearch, rmkSearchUrl } = await import('@jobforge/source-successfactors');
  const host = 'jobs.cargill.com';
  const http = createScopedHttp({ pluginId: 'live-check', domains: [host], limiter, log, signal: AbortSignal.timeout(60_000), rateLimit: { tokens: 1, intervalMs: 1000 } });
  try {
    const r = parseRmkSearch(await http.getText(rmkSearchUrl(host, 0)));
    const ok = r.rows.length > 0;
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${'successfactors parser'.padEnd(24)} ${host.padEnd(42)} ${String(r.rows.length).padStart(3)} rows · total ${r.total ?? '?'} (custom-domain RMK: parser only; the plugin can't reach this host)`);
  } catch (err) {
    failed++;
    console.log(`FAIL successfactors parser   ${host} ${(err as Error).message.slice(0, 200)}`);
  }
}
process.exit(failed ? 1 : 0);
