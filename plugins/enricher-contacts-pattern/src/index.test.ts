import { describe, expect, it } from 'vitest';
import { pluginManifestSchema, type Company, type ContactRef, type DnsResolver } from '@jobforge/plugin-sdk';
import { testContext } from '@jobforge/plugin-sdk/testing';
import plugin, { applyPattern, choosePattern, configSchema, nameParts, normalizeDomain } from './index.js';

const dns = (records: Record<string, string[]>): DnsResolver => ({
  resolveMx: async (d) => (records[d] ?? []).map((exchange, i) => ({ exchange, priority: 10 * (i + 1) })),
});
const contact = (id: string, name: string, o: Partial<ContactRef> = {}): ContactRef => ({
  id,
  name,
  role: null,
  email: null,
  emailConfidence: null,
  emailSource: null,
  status: 'active',
  ...o,
});
const company = (contacts: ContactRef[], o: Partial<Company> = {}): Company => ({
  id: 'co',
  name: 'Acme',
  domain: 'https://www.acme.com/careers',
  tags: [],
  emailDomain: null,
  emailPattern: null,
  contacts,
  ...o,
});
const ctx = (records: Record<string, string[]>, cfg = {}) => testContext(configSchema.parse(cfg), undefined, { dns: dns(records) });

describe('patterns', () => {
  it('normalizes names', () => {
    expect(nameParts('Dr. José María García-López Jr.')).toEqual({ first: 'jose', last: 'garcialopez' });
    expect(nameParts('Priya')).toEqual({ first: 'priya', last: null });
    expect(applyPattern('{f}{last}', 'Jane Doe')).toBe('jdoe');
    expect(applyPattern('{first}.{last}', 'Priya')).toBeNull();
    expect(applyPattern('{first}', 'Priya')).toBe('priya');
    expect(normalizeDomain('https://www.Acme.com/careers')).toBe('acme.com');
    expect(normalizeDomain('not a domain')).toBeNull();
  });

  it('learns from known addresses and rules out bounced patterns', () => {
    expect(choosePattern([])).toMatchObject({ pattern: '{first}.{last}', basis: 'prior', confidence: 0.38 });
    const learned = choosePattern([
      { name: 'Jane Doe', email: 'jdoe@acme.com', delivered: true },
      { name: 'Raj Patel', email: 'rpatel@acme.com', delivered: true },
    ]);
    expect(learned).toMatchObject({ pattern: '{f}{last}', basis: 'known_addresses', samples: 2 });
    expect(learned.confidence).toBeGreaterThan(0.75);
    expect(choosePattern([{ name: 'Jane Doe', email: 'jane.doe@acme.com', delivered: false }])).toMatchObject({
      pattern: '{first}',
      basis: 'prior',
    });
  });
});

describe('enricher-contacts-pattern', () => {
  it('has a valid manifest that asks only for dns', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.permissions).toEqual({ domains: [], dns: true });
  });

  it('infers emails for contacts without known addresses, never touching manual ones', async () => {
    const res = await plugin.enrich(
      ctx({ 'acme.com': ['aspmx.l.google.com'] }),
      null,
      company([
        contact('1', 'Jane Doe', { email: 'jdoe@acme.com', emailSource: 'manual', emailConfidence: 1 }),
        contact('2', 'Raj Patel'),
        contact('3', 'Priya'),
        contact('4', 'Old Guess', { email: 'old.guess@acme.com', emailSource: 'pattern:{first}.{last}' }),
        contact('5', 'Gone Person', { status: 'do_not_contact' }),
      ]),
    );
    expect(res).toMatchObject({ emailDomain: 'acme.com', mxHosts: ['aspmx.l.google.com'], pattern: '{f}{last}' });
    expect(res.contacts).toEqual([
      { contactId: '2', email: 'rpatel@acme.com', confidence: res.patternConfidence, source: 'pattern:{f}{last}' },
      { contactId: '4', email: 'oguess@acme.com', confidence: res.patternConfidence, source: 'pattern:{f}{last}' },
    ]);
    expect(res.notes.join(' ')).toMatch(/Google Workspace.*1 known address.*needs a last name/);
  });

  it('returns no emails when the domain has no MX or is unknown', async () => {
    const noMx = await plugin.enrich(ctx({}), null, company([contact('2', 'Raj Patel')]));
    expect(noMx.contacts).toEqual([]);
    expect(noMx.notes[0]).toMatch(/no MX records/);
    const noDomain = await plugin.enrich(ctx({}), null, company([contact('2', 'Raj Patel')], { domain: null }));
    expect(noDomain.emailDomain).toBeNull();
  });

  it('uses a configured pattern', async () => {
    const res = await plugin.enrich(ctx({ 'acme.com': ['mx.acme.com'] }, { knownPatterns: { 'acme.com': '{first}' } }), null, company([contact('2', 'Raj Patel')]));
    expect(res.contacts[0]).toMatchObject({ email: 'raj@acme.com', confidence: 0.9 });
  });
});
