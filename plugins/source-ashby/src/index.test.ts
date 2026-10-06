import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { HttpError, pluginManifestSchema, rawPostingSchema } from '@jobforge/plugin-sdk';
import { collect, fixtureHttp, testContext, testTarget } from '@jobforge/plugin-sdk/testing';
import plugin, { boardUrl, configSchema } from './index.js';

const fixture = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const domains = plugin.manifest.permissions.domains;
const cfg = configSchema.parse({});

describe('source-ashby', () => {
  it('has a valid manifest', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
  });

  it('maps listed postings and skips unlisted ones', async () => {
    const http = fixtureHttp({ [boardUrl('example')]: { file: fixture('example-board.json') } }, domains);
    const postings = await collect(plugin.fetch(testContext(cfg, http), testTarget('example')));

    expect(postings).toHaveLength(3);
    for (const p of postings) expect(rawPostingSchema.safeParse(p).success).toBe(true);

    const [be, design, grad] = postings;
    expect(be).toMatchObject({
      externalId: '4f3c2a1e-8b9d-4c6e-9a1f-0e2d3c4b5a61',
      title: 'Senior Backend Engineer',
      locations: ['Bengaluru, Karnataka, India', 'Remote - India'],
      remotePolicy: 'hybrid',
      department: 'Engineering',
      applyUrl: expect.stringMatching(/\/application$/),
    });
    expect(be!.postedAt?.toISOString()).toBe('2026-09-18T09:30:12.512Z');
    expect(be!.descriptionHtml).toContain('<li>5+ years of backend experience</li>');
    expect(design).toMatchObject({ remotePolicy: 'remote', locations: ['Remote'] });
    expect(grad).toMatchObject({ remotePolicy: 'onsite' });
  });

  it('honours includeCompensation in the URL', async () => {
    const http = fixtureHttp({ [boardUrl('example', false)]: { file: fixture('example-board.json') } }, domains);
    await collect(plugin.fetch(testContext({ includeCompensation: false }, http), testTarget('example')));
    expect(http.calls[0]).toMatch(/includeCompensation=false$/);
  });

  it('surfaces a missing board as a permanent HttpError', async () => {
    const http = fixtureHttp({ [boardUrl('nope')]: { file: fixture('not-found.json'), status: 404 } }, domains);
    const err = await collect(plugin.fetch(testContext(cfg, http), testTarget('nope'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).permanent).toBe(true);
  });
});
