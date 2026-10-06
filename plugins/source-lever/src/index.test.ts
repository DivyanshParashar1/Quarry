import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { HttpError, pluginManifestSchema, rawPostingSchema } from '@jobforge/plugin-sdk';
import { collect, fixtureHttp, testContext, testTarget } from '@jobforge/plugin-sdk/testing';
import plugin, { configSchema, postingsUrl } from './index.js';

const fixture = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const domains = plugin.manifest.permissions.domains;

describe('source-lever', () => {
  it('has a valid manifest', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
  });

  it('maps the recorded leverdemo postings into raw postings', async () => {
    const http = fixtureHttp({ [postingsUrl('leverdemo')]: { file: fixture('leverdemo-postings.json') } }, domains);
    const postings = await collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('leverdemo')));

    expect(postings).toHaveLength(6);
    for (const p of postings) expect(rawPostingSchema.safeParse(p).success).toBe(true);

    const [first, second] = postings;
    expect(first!.externalId).toBe('681fbc53-1e34-4a46-8677-3a78118674eb');
    expect(first!.title).toBe('Approved Professional 3');
    expect(first!.locations).toEqual(['Baltimore, MD']);
    expect(first!.remotePolicy).toBe('remote');
    expect(first!.department).toBe('Operations'); // falls back to team
    expect(first!.applyUrl).toMatch(/\/apply$/);
    expect(first!.postedAt?.getTime()).toBe(1565990241800);
    expect(second!.remotePolicy).toBe('hybrid');
    expect(second!.department).toBe('Customer Success');
  });

  it('includes titled lists in the description', async () => {
    const http = fixtureHttp({ [postingsUrl('leverdemo')]: { file: fixture('leverdemo-postings.json') } }, domains);
    const postings = await collect(plugin.fetch(testContext({}, http), testTarget('leverdemo')));
    const withLists = postings.find((p) => (p.payload as { lists: unknown[] }).lists.length > 0);
    expect(withLists?.descriptionHtml).toMatch(/<h3>.+<\/h3>\s*<ul>/);
  });

  it('surfaces a missing company as a permanent HttpError', async () => {
    const http = fixtureHttp({ [postingsUrl('nope')]: { file: fixture('not-found.json'), status: 404 } }, domains);
    const err = await collect(plugin.fetch(testContext({}, http), testTarget('nope'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).permanent).toBe(true);
  });
});
