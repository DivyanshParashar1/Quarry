import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { pluginManifestSchema, decodeEntities, HttpError, hostAllowed, parseRelativePosted, matchesLocationFilter, remotePolicyFromText } from './index.js';

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

  it('rejects bare/mid wildcards and scheme-prefixed domains', () => {
    for (const d of ['*.com', '*', 'api.*.example.com', 'https://api.example.com', 'API.example.com', 'localhost']) {
      const r = pluginManifestSchema.safeParse({ ...base, permissions: { domains: [d] } });
      expect(r.success, d).toBe(false);
    }
  });

  it('accepts a leading-label wildcard and matches only subdomains', () => {
    expect(pluginManifestSchema.safeParse({ ...base, permissions: { domains: ['*.example.com'] } }).success).toBe(true);
    expect(hostAllowed('a.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('badexample.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true);
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

describe('source helpers', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  it('parses relative posted strings', () => {
    expect(parseRelativePosted('Posted Today', now)?.toISOString()).toBe('2026-10-07T00:00:00.000Z');
    expect(parseRelativePosted('Posted Yesterday', now)?.toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(parseRelativePosted('Posted 3 Days Ago', now)?.toISOString()).toBe('2026-10-04T00:00:00.000Z');
    expect(parseRelativePosted('Posted 30+ Days Ago', now)?.toISOString()).toBe('2026-09-07T00:00:00.000Z');
    expect(parseRelativePosted('2 weeks ago', now)?.toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(parseRelativePosted('whenever', now)).toBeNull();
  });
  it('filters locations by substring, keeping unknowns', () => {
    expect(matchesLocationFilter(['Bengaluru, India'], ['india'])).toBe(true);
    expect(matchesLocationFilter(['Austin, TX'], ['india'])).toBe(false);
    expect(matchesLocationFilter([], ['india'])).toBe(true);
    expect(matchesLocationFilter(['Austin, TX'], [])).toBe(true);
  });
  it('infers remote policy from text', () => {
    expect(remotePolicyFromText('Hybrid')).toBe('hybrid');
    expect(remotePolicyFromText('Fully Remote')).toBe('remote');
    expect(remotePolicyFromText('On-site')).toBe('onsite');
    expect(remotePolicyFromText('Bengaluru')).toBeNull();
  });
});
