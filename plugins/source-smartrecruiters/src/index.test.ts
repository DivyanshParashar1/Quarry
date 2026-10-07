import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pluginManifestSchema, rawPostingSchema } from '@jobforge/plugin-sdk';
import { collect, fixtureHttp, testContext, testTarget, type FixtureRouteSpec } from '@jobforge/plugin-sdk/testing';
import plugin, { configSchema, detailUrl, listUrl } from './index.js';

const fixture = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const domains = plugin.manifest.permissions.domains;
const details = JSON.parse(readFileSync(fixture('visa-details.json'), 'utf8')) as Record<string, unknown>;

function routes(): Record<string, FixtureRouteSpec> {
  // The fixture pages hold 5 items each, but the plugin asks for 100 per page
  // and advances by what it received, so page 2 is requested at offset 5.
  const r: Record<string, FixtureRouteSpec> = {
    [listUrl('Visa', 0)]: { file: fixture('visa-page-0.json') },
    [listUrl('Visa', 5)]: { file: fixture('visa-page-1.json') },
  };
  for (const [id, body] of Object.entries(details)) r[detailUrl('Visa', id)] = { body };
  return r;
}

describe('source-smartrecruiters', () => {
  it('has a valid manifest and default config', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(configSchema.parse({})).toMatchObject({ locations: [], fetchDetails: true });
  });

  it('pages through postings and assembles the job ad', async () => {
    const http = fixtureHttp(routes(), domains);
    const postings = await collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('Visa', 'Visa')));
    expect(postings).toHaveLength(7);
    for (const p of postings) expect(rawPostingSchema.safeParse(p).success).toBe(true);
    const first = postings[0]!;
    expect(first.externalId).toBe('744000000000');
    expect(first.title).toBe('Software Engineer');
    expect(first.locations).toEqual(['Bengaluru, KA, IN']);
    expect(first.department).toBe('Technology');
    expect(first.url).toMatch(/^https:\/\/jobs\.smartrecruiters\.com\/Visa\/744000000000/);
    expect(first.applyUrl).toMatch(/oga=true$/);
    expect(first.descriptionHtml).toMatch(/^<h3>Job Description<\/h3><p>Build payment systems/);
    expect(first.descriptionHtml).toContain('Visa is a world leader'); // company blurb last
    expect(first.postedAt?.toISOString()).toBe('2026-09-10T08:30:00.000Z');
    expect(postings[2]!.remotePolicy).toBe('remote');
  });

  it('filters by location before fetching details', async () => {
    const http = fixtureHttp(routes(), domains);
    const postings = await collect(
      plugin.fetch(testContext(configSchema.parse({ locations: ['singapore'] }), http), testTarget('Visa')),
    );
    expect(postings.map((p) => p.locations[0])).toEqual(['Singapore, SG']);
    expect(http.calls.filter((u) => /postings\/\d+$/.test(u))).toHaveLength(1);
  });

  it('yields nothing for an empty company', async () => {
    const http = fixtureHttp({ [listUrl('Nobody', 0)]: { file: fixture('empty.json') } }, domains);
    expect(await collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('Nobody')))).toEqual([]);
  });

  it('rejects an unexpected response shape', async () => {
    const http = fixtureHttp({ [listUrl('Weird', 0)]: { body: { content: 'x' } } }, domains);
    await expect(collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('Weird')))).rejects.toThrow(
      /unexpected SmartRecruiters response/,
    );
  });
});
