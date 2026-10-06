import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { HttpError, pluginManifestSchema, rawPostingSchema } from '@jobforge/plugin-sdk';
import { collect, fixtureHttp, testContext, testTarget } from '@jobforge/plugin-sdk/testing';
import plugin, { boardUrl, configSchema } from './index.js';

const fixture = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const domains = plugin.manifest.permissions.domains;

describe('source-greenhouse', () => {
  it('has a valid manifest and default config', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(configSchema.parse({})).toEqual({ includeContent: true });
  });

  it('maps the recorded airbnb board into raw postings', async () => {
    const http = fixtureHttp({ [boardUrl('airbnb', true)]: { file: fixture('airbnb-jobs.json') } }, domains);
    const postings = await collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('airbnb')));

    expect(postings).toHaveLength(6);
    for (const p of postings) expect(rawPostingSchema.safeParse(p).success).toBe(true);

    const first = postings[0]!;
    expect(first.externalId).toBe('8184174');
    expect(first.title).toBe('Account Manager ');
    expect(first.locations).toEqual(['London, United Kingdom']);
    expect(first.remotePolicy).toBe('hybrid'); // from "Workplace Type" metadata
    expect(first.department).toBe('Business Development');
    expect(first.url).toMatch(/^https:\/\/careers\.airbnb\.com\//);
    expect(first.postedAt?.toISOString()).toBe('2026-09-09T08:35:19.000Z');
    // entity-escaped content is decoded into real HTML
    expect(first.descriptionHtml).toMatch(/^<div/);
    expect(first.descriptionHtml).not.toMatch(/&lt;/);
  });

  it('url-encodes the board token', () => {
    expect(boardUrl('a b/c', false)).toBe('https://boards-api.greenhouse.io/v1/boards/a%20b%2Fc/jobs');
  });

  it('surfaces a missing board as a permanent HttpError', async () => {
    const http = fixtureHttp({ [boardUrl('nope', true)]: { file: fixture('not-found.json'), status: 404 } }, domains);
    const err = await collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('nope'))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).permanent).toBe(true);
  });

  it('rejects an unexpected response shape', async () => {
    const http = fixtureHttp({ [boardUrl('weird', true)]: { body: { jobs: [{ nope: 1 }] } } }, domains);
    await expect(
      collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('weird'))),
    ).rejects.toThrow(/unexpected Greenhouse response/);
  });
});
