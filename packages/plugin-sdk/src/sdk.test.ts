import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { pluginManifestSchema, decodeEntities, HttpError } from './index.js';

const base = {
  id: 'source-x',
  version: '0.1.0',
  stage: 'source',
  description: 'x',
  configSchema: z.object({}),
  permissions: { domains: ['api.example.com'] },
  sideEffects: 'none',
};

describe('pluginManifestSchema', () => {
  it('accepts a valid manifest', () => {
    expect(pluginManifestSchema.safeParse(base).success).toBe(true);
  });

  it('rejects wildcard and scheme-prefixed domains', () => {
    for (const d of ['*.example.com', 'https://api.example.com', 'API.example.com', 'localhost']) {
      const r = pluginManifestSchema.safeParse({ ...base, permissions: { domains: [d] } });
      expect(r.success, d).toBe(false);
    }
  });

  it('rejects an actor without external side effects', () => {
    const r = pluginManifestSchema.safeParse({ ...base, id: 'actor-x', stage: 'actor' });
    expect(r.success).toBe(false);
  });

  it('rejects a non-zod configSchema and bad semver', () => {
    expect(pluginManifestSchema.safeParse({ ...base, configSchema: {} }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...base, version: 'v1' }).success).toBe(false);
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric references', () => {
    expect(decodeEntities('&lt;p&gt;A &amp; B &#8212; C&#x27;s&nbsp;x&lt;/p&gt;')).toBe("<p>A & B — C's x</p>");
  });
  it('leaves unknown references alone', () => {
    expect(decodeEntities('&bogus; &')).toBe('&bogus; &');
  });
});

describe('HttpError.permanent', () => {
  it('classifies statuses', () => {
    expect(new HttpError('x', 'u', 404).permanent).toBe(true);
    expect(new HttpError('x', 'u', 429).permanent).toBe(false);
    expect(new HttpError('x', 'u', 503).permanent).toBe(false);
    expect(new HttpError('x', 'u', null).permanent).toBe(false);
  });
});
