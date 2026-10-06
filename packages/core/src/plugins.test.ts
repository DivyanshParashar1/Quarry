import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { DomainNotAllowedError } from '@jobforge/plugin-sdk';
import { buildContext, loadPlugin, PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { fakeClock, silentLogger } from './test-utils.js';

const manifest = {
  id: 'source-fake',
  version: '1.0.0',
  stage: 'source' as const,
  description: 'fake',
  configSchema: z.object({ pageSize: z.number().int().default(50) }),
  permissions: { domains: ['api.example.com'] },
  sideEffects: 'none' as const,
};

const plugin = {
  manifest,
  async *fetch() {
    /* nothing */
  },
};

describe('loadPlugin', () => {
  it('loads a valid plugin and applies config defaults', () => {
    const loaded = loadPlugin(plugin);
    expect(loaded.manifest.id).toBe('source-fake');
    expect(loaded.config).toEqual({ pageSize: 50 });
  });

  it('unwraps a default export', () => {
    expect(loadPlugin({ default: plugin }).manifest.id).toBe('source-fake');
  });

  it('rejects an invalid manifest with a readable message', () => {
    expect(() => loadPlugin({ ...plugin, manifest: { ...manifest, version: 'x' } })).toThrow(/version/);
  });

  it('rejects a plugin missing its stage method', () => {
    expect(() => loadPlugin({ manifest })).toThrow(/requires a fetch\(\)/);
    expect(() =>
      loadPlugin({
        manifest: { ...manifest, id: 'actor-x', stage: 'actor', sideEffects: 'external' },
        prepare: async () => ({}),
      }),
    ).toThrow(/execute/);
  });

  it('rejects invalid config', () => {
    expect(() => loadPlugin(plugin, { pageSize: 'big' })).toThrow(/pageSize/);
  });
});

describe('PluginRegistry', () => {
  it('rejects duplicate ids and filters by stage', () => {
    const r = new PluginRegistry();
    r.register(plugin);
    expect(() => r.register(plugin)).toThrow(/duplicate/);
    expect(r.byStage('source')).toHaveLength(1);
    expect(r.byStage('matcher')).toHaveLength(0);
    expect(r.source('source-fake').manifest.id).toBe('source-fake');
    expect(() => r.get('nope')).toThrow(/unknown plugin/);
  });
});

describe('buildContext', () => {
  it('scopes http to the manifest domains', async () => {
    const ctx = buildContext(loadPlugin(plugin), {
      limiter: new DomainRateLimiter(undefined, fakeClock()),
      log: silentLogger,
      signal: new AbortController().signal,
      dryRun: true,
      fetch: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    expect(ctx.dryRun).toBe(true);
    expect(ctx.config).toEqual({ pageSize: 50 });
    await expect(ctx.http.getJson('https://other.com/')).rejects.toBeInstanceOf(DomainNotAllowedError);
    await expect(ctx.http.getJson('https://api.example.com/')).resolves.toEqual({});
  });
});
