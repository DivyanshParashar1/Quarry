import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeGmail } from '@jobforge/plugin-sdk/testing';
import type { PluginManifest, TrackerPlugin } from '@jobforge/plugin-sdk';
import { createDnsResolver, requireGmail, scopeGmail } from './capabilities.js';
import { buildContext, loadPlugin } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { silentLogger } from './test-utils.js';

const manifest = (perms: PluginManifest['permissions']): PluginManifest => ({
  id: 'p',
  version: '0.0.1',
  stage: 'tracker',
  description: '',
  configSchema: z.object({}),
  permissions: perms,
  sideEffects: 'none',
});

describe('scopeGmail', () => {
  it('gives read-only plugins no send method, and nothing without a gmail permission', () => {
    const full = fakeGmail();
    const ro = scopeGmail(full, manifest({ domains: [], gmail: ['read'] }))!;
    expect(ro.send).toBeUndefined();
    expect(typeof ro.search).toBe('function');
    expect(Object.isFrozen(ro)).toBe(true);
    const so = scopeGmail(full, manifest({ domains: [], gmail: ['send'] }))!;
    expect(so.search).toBeUndefined();
    expect(scopeGmail(full, manifest({ domains: [] }))).toBeUndefined();
  });

  it('is absent when Gmail is not connected; requireGmail says how to fix it', () => {
    expect(scopeGmail(undefined, manifest({ domains: [], gmail: ['read'] }))).toBeUndefined();
    expect(() => requireGmail(undefined)).toThrow(/jf gmail auth/);
  });

  it('buildContext only injects dns/gmail for declared permissions', () => {
    const tracker: TrackerPlugin = { manifest: manifest({ domains: [], gmail: ['read'] }), async *poll() {} };
    const deps = {
      limiter: new DomainRateLimiter(),
      log: silentLogger,
      signal: new AbortController().signal,
      dryRun: true,
      gmail: fakeGmail(),
      dns: createDnsResolver({ resolver: { resolveMx: async () => [] } }),
    };
    const ctx = buildContext(loadPlugin(tracker), deps);
    expect(ctx.dns).toBeUndefined();
    expect(ctx.gmail?.send).toBeUndefined();
    expect(ctx.gmail?.address).toBe('me@example.com');
  });
});

describe('createDnsResolver', () => {
  it('sorts by priority, caches, and maps NXDOMAIN to []', async () => {
    let calls = 0;
    const r = createDnsResolver({
      resolver: {
        resolveMx: async (d: string) => {
          calls++;
          if (d === 'nope.example') throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
          return [
            { exchange: 'b.mx', priority: 20 },
            { exchange: 'a.mx', priority: 10 },
          ];
        },
      },
    });
    expect((await r.resolveMx('Acme.com')).map((m) => m.exchange)).toEqual(['a.mx', 'b.mx']);
    await r.resolveMx('acme.com');
    expect(calls).toBe(1);
    expect(await r.resolveMx('nope.example')).toEqual([]);
  });
});
