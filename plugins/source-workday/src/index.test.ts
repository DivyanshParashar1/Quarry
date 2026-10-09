import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError, pluginManifestSchema, rawPostingSchema, type HttpRequestInit } from '@jobforge/plugin-sdk';
import { collect, fixtureHttp, testContext, testTarget, type FixtureRouteSpec } from '@jobforge/plugin-sdk/testing';
import plugin, {
  configSchema,
  detailApiUrl,
  formatWorkdayToken,
  jobsApiUrl,
  parseWorkdayToken,
  resolveOptions,
} from './index.js';

const fixture = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const domains = plugin.manifest.permissions.domains;
const board = parseWorkdayToken('walmart.wd5/WalmartExternal');
const details = JSON.parse(readFileSync(fixture('walmart-details.json'), 'utf8')) as Record<string, unknown>;

function walmartRoutes(): Record<string, FixtureRouteSpec> {
  const routes: Record<string, FixtureRouteSpec> = {
    [`POST ${jobsApiUrl(board)}`]: (init: HttpRequestInit) => {
      const { offset } = JSON.parse(init.body ?? '{}') as { offset: number };
      return { file: fixture(`walmart-page-${offset / 20}.json`) };
    },
  };
  for (const [path, body] of Object.entries(details)) routes[detailApiUrl(board, path)] = { body };
  return routes;
}

describe('source-workday token parsing', () => {
  it('parses compact and URL forms', () => {
    expect(parseWorkdayToken('walmart.wd5/WalmartExternal')).toEqual({
      host: 'walmart.wd5.myworkdayjobs.com',
      tenant: 'walmart',
      site: 'WalmartExternal',
    });
    expect(parseWorkdayToken('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x')).toEqual({
      host: 'nvidia.wd5.myworkdayjobs.com',
      tenant: 'nvidia',
      site: 'NVIDIAExternalCareerSite',
    });
    expect(parseWorkdayToken('https://wd3.myworkdaysite.com/en-US/recruiting/acme/Careers')).toEqual({
      host: 'wd3.myworkdaysite.com',
      tenant: 'acme',
      site: 'Careers',
    });
    expect(parseWorkdayToken('wd3.myworkdaysite.com/acme/Careers').tenant).toBe('acme');
    expect(() => parseWorkdayToken('walmart')).toThrow(/invalid Workday board token/);
  });

  it('round-trips the canonical token', () => {
    for (const t of ['walmart.wd5/WalmartExternal', 'wd3.myworkdaysite.com/acme/Careers']) {
      expect(formatWorkdayToken(parseWorkdayToken(t))).toBe(t);
    }
  });
});

describe('source-workday', () => {
  it('has a valid manifest (wildcard host) and default config', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(configSchema.parse({})).toMatchObject({ searchText: '', locations: [], fetchDetails: true });
  });

  it('pages through the board and maps postings with details', async () => {
    const http = fixtureHttp(walmartRoutes(), domains);
    const postings = await collect(
      plugin.fetch(testContext(configSchema.parse({}), http), testTarget('walmart.wd5/WalmartExternal', 'Walmart')),
    );
    expect(postings).toHaveLength(23);
    for (const p of postings) expect(rawPostingSchema.safeParse(p).success).toBe(true);
    // two list pages, offsets 0 and 20, sending the configured page size
    const listBodies = http.bodies.filter((b): b is string => !!b).map((b) => JSON.parse(b) as { offset: number; limit: number });
    expect(listBodies.map((b) => b.offset)).toEqual([0, 20]);
    expect(listBodies[0]!.limit).toBe(20);

    const first = postings[0]!;
    expect(first.externalId).toBe('R-2000100');
    expect(first.title).toBe('Software Engineer III');
    expect(first.locations).toEqual(['Bangalore, Karnataka, India']);
    expect(first.remotePolicy).toBe('hybrid');
    expect(first.url).toMatch(/^https:\/\/walmart\.wd5\.myworkdayjobs\.com\/WalmartExternal\/job\//);
    expect(first.descriptionHtml).toContain('Java & Kotlin');
    expect(first.postedAt?.toISOString().slice(0, 10)).toBe('2026-09-01');
    // "2 Locations" in the list is resolved from the detail
    const multi = postings.find((p) => p.externalId === 'R-2000103')!;
    expect(multi.locations).toEqual(['Sunnyvale, CA, United States', 'Chennai, Tamil Nadu, India']);
  });

  it('filters by location before fetching details', async () => {
    const http = fixtureHttp(walmartRoutes(), domains);
    const cfg = configSchema.parse({ locations: ['India'] });
    const postings = await collect(plugin.fetch(testContext(cfg, http), testTarget('walmart.wd5/WalmartExternal')));
    expect(postings.length).toBeGreaterThan(0);
    for (const p of postings) expect(p.locations.some((l) => l.includes('India'))).toBe(true);
    // US-only postings never triggered a detail request
    const detailCalls = http.calls.filter((u) => u.includes('/job/'));
    expect(detailCalls.some((u) => u.includes('/job/Sunnyvale/') || u.includes('/job/Bentonville/'))).toBe(true); // only the "2 Locations" one
    expect(detailCalls.filter((u) => u.includes('/job/Bentonville/'))).toHaveLength(0);
  });

  it('honours per-target options over plugin config', async () => {
    expect(resolveOptions(configSchema.parse({ searchText: 'x' }), { searchText: 'intern', bogus: 1 }).searchText).toBe('intern');
    expect(() => resolveOptions(configSchema.parse({}), { maxPostings: -1 })).toThrow(/invalid Workday target options/);
    const http = fixtureHttp(walmartRoutes(), domains);
    const postings = await collect(
      plugin.fetch(
        testContext(configSchema.parse({}), http),
        testTarget('walmart.wd5/WalmartExternal', 'Walmart', { maxPostings: 5, fetchDetails: false }),
      ),
    );
    expect(postings).toHaveLength(5);
    expect(http.calls.every((u) => u.endsWith('/jobs'))).toBe(true);
    expect(postings[0]!.descriptionHtml).toBeNull();
  });

  it('keeps a posting when its detail request fails', async () => {
    const routes = walmartRoutes();
    const firstPath = Object.keys(details)[0]!;
    routes[detailApiUrl(board, firstPath)] = { status: 500, body: {} };
    const postings = await collect(
      plugin.fetch(testContext(configSchema.parse({}), fixtureHttp(routes, domains)), testTarget('walmart.wd5/WalmartExternal')),
    );
    expect(postings).toHaveLength(23);
    expect(postings[0]!.descriptionHtml).toBeNull();
  });

  it('treats a malformed token as a permanent failure', async () => {
    const err = await collect(plugin.fetch(testContext(configSchema.parse({})), testTarget('nope'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).permanent).toBe(true);
  });

  it('rejects an unexpected list shape', async () => {
    const http = fixtureHttp({ [`POST ${jobsApiUrl(board)}`]: { body: { jobPostings: 'nope' } } }, domains);
    await expect(
      collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('walmart.wd5/WalmartExternal'))),
    ).rejects.toThrow(/unexpected Workday response/);
  });

  it('explains a 422 (unknown or moved tenant/site) as a permanent failure', async () => {
    const http = fixtureHttp({ [`POST ${jobsApiUrl(board)}`]: { status: 422, body: { errorCode: 'HTTP_422' } } }, domains);
    const err = await collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('walmart.wd5/WalmartExternal'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).permanent).toBe(true);
    expect((err as HttpError).message).toMatch(/moved data centre/);
  });
});

// Recorded from live tenants (2026-10-09), not hand-built.
describe('source-workday against recorded responses', () => {
  it('skips stub entries (bulletFields only) instead of failing the board', async () => {
    const abbott = parseWorkdayToken('abbott.wd5/abbottcareers');
    const http = fixtureHttp(
      {
        [`POST ${jobsApiUrl(abbott)}`]: (init: HttpRequestInit) =>
          (JSON.parse(init.body ?? '{}') as { offset: number }).offset === 0 ? { file: fixture('real-abbott-page-0-with-stub.json') } : { body: { total: 0, jobPostings: [] } },
      },
      domains,
    );
    const cfg = configSchema.parse({ fetchDetails: false, maxPostings: 50 });
    const postings = await collect(plugin.fetch(testContext(cfg, http), testTarget('abbott.wd5/abbottcareers', 'Abbott')));
    expect(postings).toHaveLength(19); // 20 entries, one stub
    for (const p of postings) expect(rawPostingSchema.safeParse(p).success).toBe(true);
  });

  it('maps a real State Street page and details', async () => {
    const ss = parseWorkdayToken('statestreet.wd1/Global');
    const realDetails = JSON.parse(readFileSync(fixture('real-statestreet-details.json'), 'utf8')) as Record<string, unknown>;
    const routes: Record<string, FixtureRouteSpec> = { [`POST ${jobsApiUrl(ss)}`]: { file: fixture('real-statestreet-page-0.json') } };
    // The first posting's detail really answers 403 "permission denied" (recorded as such).
    for (const [path, body] of Object.entries(realDetails)) routes[detailApiUrl(ss, path)] = { status: (body as { httpStatus?: number }).httpStatus ?? 200, body };
    const cfg = configSchema.parse({ maxPostings: 2 });
    const postings = await collect(plugin.fetch(testContext(cfg, fixtureHttp(routes, domains)), testTarget('statestreet.wd1/Global', 'State Street')));
    expect(postings).toHaveLength(2);
    const p = postings[1]!;
    expect(p).toMatchObject({ externalId: 'R-797933', title: 'Financial Reporting, Assistant Vice President', locations: ['Toronto, Ontario'] });
    expect(p.url).toBe('https://statestreet.wd1.myworkdayjobs.com/Global/job/Toronto-Ontario/Financial-Reporting--Assistant-Vice-President_R-797933');
    expect(p.descriptionHtml!.length).toBeGreaterThan(200);
    // A refused detail keeps the list-level posting ("5 Locations" can't be resolved without it).
    expect(postings[0]).toMatchObject({ externalId: 'R-792664', descriptionHtml: null, locations: [] });
  });
});
