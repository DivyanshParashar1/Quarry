import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertNotBlocked,
  classifyHeadline,
  parsePeopleSearch,
  pluginManifestSchema,
  SessionBlockedError,
  type BrowserHandle,
  type Company,
} from '@jobforge/plugin-sdk';
import { fakeBrowser, testContext } from '@jobforge/plugin-sdk/testing';
import plugin, { configSchema } from './index.js';

const html = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url)), 'utf8');
const company: Company = { id: 'c1', name: 'Walmart Global Tech', domain: 'walmart.com', tags: [], emailDomain: null, emailPattern: null, contacts: [] };

describe('LinkedIn helpers', () => {
  it('parses people search rows, skipping out-of-network members', () => {
    const rows = parsePeopleSearch(html('people-search.html'));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      name: 'Ananya Sharma',
      headline: 'Senior Software Engineer - Payments at Walmart Global Tech',
      location: 'Bengaluru, Karnataka, India',
      profileUrl: 'https://www.linkedin.com/in/ananya-sharma-1a2b3c/',
    });
  });

  it('classifies headlines', () => {
    expect(classifyHeadline('Senior Software Engineer - Payments at Walmart Global Tech')).toEqual({ roleHint: 'engineer', seniorityHint: 'senior', department: 'Payments' });
    expect(classifyHeadline('Engineering Manager - Search').roleHint).toBe('manager');
    expect(classifyHeadline('Talent Acquisition Partner - Tech Hiring').roleHint).toBe('recruiter');
    expect(classifyHeadline('SDE Intern @ Walmart Global Tech')).toMatchObject({ roleHint: 'engineer', seniorityHint: 'junior' });
    expect(classifyHeadline('VP Engineering').roleHint).toBe('leader');
  });

  it('detects challenge pages (incl. the 999 security check)', () => {
    expect(() => assertNotBlocked('https://www.linkedin.com/feed/', html('security-check.html'))).toThrow(SessionBlockedError);
    expect(() => assertNotBlocked('https://www.linkedin.com/checkpoint/challenge/x', '')).toThrow(/captcha/);
    expect(() => assertNotBlocked('https://www.linkedin.com/authwall?trk=x', '')).toThrow(/login/);
    expect(() => assertNotBlocked('https://www.linkedin.com/x', '<html>Request denied, status code 999</html>', '999')).toThrow(/999/);
    expect(() => assertNotBlocked('https://www.linkedin.com/search/results/people/', html('people-search.html'))).not.toThrow();
  });
});

describe('enricher-linkedin-employees', () => {
  it('has a valid manifest scoped to linkedin.com with a browser', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.permissions).toEqual({ domains: ['www.linkedin.com'], browser: true });
  });

  it('dry run never opens LinkedIn', async () => {
    const browser = fakeBrowser({ pages: {} });
    const r = await plugin.enrich(testContext(configSchema.parse({}), undefined, { browser: browser as BrowserHandle, dryRun: true }), null, company);
    expect(r.profiles).toEqual([]);
    expect(browser.actions).toEqual([]);
  });

  it('resolves the company id, searches people, classifies them', async () => {
    const browser = fakeBrowser({
      pages: {
        'https://www.linkedin.com/search/results/companies/*': html('company-search.html'),
        'https://www.linkedin.com/company/walmartglobaltech/': html('company-page.html'),
        'https://www.linkedin.com/search/results/people/*': html('people-search.html'),
      },
    });
    const cfg = configSchema.parse({ keywords: ['software engineer', 'SDE'], maxProfiles: 4 });
    const r = await plugin.enrich(testContext(cfg, undefined, { browser: browser as BrowserHandle, dryRun: false }), null, company);
    expect(r.linkedinSlug).toBe('walmartglobaltech');
    expect(r.linkedinId).toBe('3627928');
    expect(r.profiles.map((p) => [p.name, p.roleHint])).toEqual([
      ['Ananya Sharma', 'engineer'],
      ['Rohit Verma', 'engineer'],
      ['Priya Nair', 'manager'],
      ['Karthik Rao', 'recruiter'],
    ]);
    const searches = browser.actions.filter((a) => a.type === 'goto' && a.url.includes('/search/results/people/'));
    expect(searches).toHaveLength(1); // the first page already filled maxProfiles
    expect(decodeURIComponent(searches[0]!.url)).toContain('currentCompany=["3627928"]');
    expect(browser.actions.some((a) => a.type === 'mouse')).toBe(true);
  });

  it('skips the company lookup when the id is known and skips known profiles', async () => {
    const browser = fakeBrowser({ pages: { 'https://www.linkedin.com/search/results/people/*': html('people-search.html') } });
    const known: Company = {
      ...company,
      linkedinId: '3627928',
      contacts: [{ id: 'x', name: 'Ananya Sharma', role: null, email: null, emailConfidence: null, emailSource: null, status: 'active', linkedinUrl: 'https://www.linkedin.com/in/ananya-sharma-1a2b3c/' }],
    };
    const r = await plugin.enrich(testContext(configSchema.parse({ keywords: ['engineer'] }), undefined, { browser: browser as BrowserHandle, dryRun: false }), null, known);
    expect(r.profiles.map((p) => p.name)).not.toContain('Ananya Sharma');
    expect(browser.actions.filter((a) => a.type === 'goto')).toHaveLength(1);
  });

  it('stops at a security check with SessionBlockedError', async () => {
    const browser = fakeBrowser({ pages: { 'https://www.linkedin.com/search/results/people/*': html('security-check.html') } });
    await expect(
      plugin.enrich(testContext(configSchema.parse({}), undefined, { browser: browser as BrowserHandle, dryRun: false }), null, { ...company, linkedinId: '1' }),
    ).rejects.toBeInstanceOf(SessionBlockedError);
  });
});
