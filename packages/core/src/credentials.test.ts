import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PluginManifest, TrackerPlugin } from '@quarry/plugin-sdk';
import { generatePassword, keychainCredentials, type KeychainBackend } from './credentials.js';
import { buildContext, loadPlugin } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { silentLogger } from './test-utils.js';

const memory = (): KeychainBackend & { items: Map<string, string> } => {
  const items = new Map<string, string>();
  return { items, get: async (a) => items.get(a) ?? null, set: async (a, s) => (items.set(a, s), true) };
};

describe('generatePassword', () => {
  it('is 20 characters with every character class, and different each time', () => {
    const a = generatePassword();
    expect(a).toHaveLength(20);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[0-9]/);
    expect(a).toMatch(/[!@#$%^&*\-_=+?]/);
    expect(generatePassword()).not.toBe(a);
  });
});

describe('keychainCredentials', () => {
  it('namespaces accounts by plugin id and stores what create() returns', async () => {
    const kc = memory();
    const store = keychainCredentials('actor-apply-workday', kc);
    expect(await store.get('Host/T:me@x.com')).toBeNull();
    const pw = await store.create('Host/T:me@x.com');
    expect([...kc.items]).toEqual([['actor-apply-workday:host/t:me@x.com', pw]]);
    expect(await store.get('host/t:ME@x.com')).toBe(pw);
    expect(await keychainCredentials('other-plugin', kc).get('host/t:me@x.com')).toBeNull();
  });

  it('refuses to hand out a password it could not store', async () => {
    const broken: KeychainBackend = { get: async () => null, set: async () => false };
    await expect(keychainCredentials('p', broken).create('a')).rejects.toThrow(/no OS keychain/);
  });

  it('buildContext injects credentials only for plugins that declare them', () => {
    const plugin = (credentials?: boolean): TrackerPlugin => ({
      manifest: { id: 'p', version: '0.0.1', stage: 'tracker', description: '', configSchema: z.object({}), permissions: { domains: [], ...(credentials ? { credentials } : {}) }, sideEffects: 'none' } as PluginManifest,
      async *poll() {},
    });
    const seen: string[] = [];
    const deps = {
      limiter: new DomainRateLimiter(),
      log: silentLogger,
      signal: new AbortController().signal,
      dryRun: true,
      credentials: (id: string) => (seen.push(id), keychainCredentials(id, memory())),
    };
    expect(buildContext(loadPlugin(plugin()), deps).credentials).toBeUndefined();
    expect(buildContext(loadPlugin(plugin(true)), deps).credentials).toBeDefined();
    expect(seen).toEqual(['p']);
  });
});
