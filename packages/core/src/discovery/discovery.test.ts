import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { DomainRateLimiter } from '../rate-limiter.js';
import {
  careerLinks,
  classifyUrl,
  normalizeDomain,
  registrableDomain,
  scanHtml,
  slugCandidates,
} from './detect.js';
import { isPathAllowed, parseRobots, RobotsCache } from './robots.js';
import { createPageFetcher, RobotsDisallowedError, type PageFetcher, type PageResponse } from './page-fetcher.js';
import { discoverAts } from './discover-ats.js';

const log = pino({ level: 'silent' });

describe('classifyUrl', () => {
  it.each([
    ['https://boards.greenhouse.io/Stripe', 'greenhouse', 'stripe'],
    ['https://job-boards.greenhouse.io/figma/jobs/123', 'greenhouse', 'figma'],
    ['https://boards.greenhouse.io/embed/job_board?for=airbnb&b=x', 'greenhouse', 'airbnb'],
    ['https://boards-api.greenhouse.io/v1/boards/discord/jobs', 'greenhouse', 'discord'],
    ['https://jobs.lever.co/Netflix/abc-123', 'lever', 'netflix'],
    ['https://api.lever.co/v0/postings/plaid?mode=json', 'lever', 'plaid'],
    ['https://jobs.ashbyhq.com/Linear', 'ashby', 'Linear'],
    ['https://api.ashbyhq.com/posting-api/job-board/ramp', 'ashby', 'ramp'],
    ['https://walmart.wd5.myworkdayjobs.com/en-US/WalmartExternal/job/Bangalore/x_R-1', 'workday', 'walmart.wd5/WalmartExternal'],
    ['https://wd3.myworkdaysite.com/recruiting/acme/Careers', 'workday', 'wd3.myworkdaysite.com/acme/Careers'],
    ['https://jobs.smartrecruiters.com/Visa/7440001', 'smartrecruiters', 'Visa'],
    ['https://careers.smartrecruiters.com/BoschGroup', 'smartrecruiters', 'BoschGroup'],
    ['https://career4.successfactors.com/career?company=acmeP&career_ns=job_listing', 'successfactors', 'career4.successfactors.com/acmeP'],
    ['https://jobs.acme.sapsf.com/search/?q=', 'successfactors', 'jobs.acme.sapsf.com'],
    ['https://sbi.taleo.net/careersection/ex/jobsearch.ftl?lang=en', 'taleo', 'sbi/ex'],
  ])('%s → %s %s', (url, ats, token) => {
    expect(classifyUrl(url)).toEqual({ atsType: ats, boardToken: token });
  });

  it.each([
    'https://example.com/careers',
    'https://boards.greenhouse.io/',
    'https://boards.greenhouse.io/embed/job_board',
    'https://jobs.lever.co/',
    'https://www.myworkdayjobs.com/',
    'https://rmkcdn.successfactors.com/abc/main.css',
    'https://acme.taleo.net/careersection/rest/jobboard/searchjobs',
    'not a url',
  ])('ignores %s', (url) => {
    expect(classifyUrl(url)).toBeNull();
  });
});

describe('scanHtml', () => {
  it('finds embeds, links and inline configs, most-referenced first', () => {
    const html = `
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
      <a href="https://boards.greenhouse.io/acme/jobs/1">Job 1</a>
      <a href="https://boards.greenhouse.io/acme/jobs/2">Job 2</a>
      <a href="https://jobs.lever.co/acme-old">old board</a>
      <a href="/about">About</a>`;
    const found = scanHtml(html, 'https://acme.com/careers');
    expect(found.map((d) => `${d.atsType}:${d.boardToken}`)).toEqual(['greenhouse:acme', 'lever:acme-old']);
    expect(found[0]!.confidence).toBeGreaterThan(found[1]!.confidence);
    expect(found[0]!.evidence).toBe('https://acme.com/careers');
  });

  it('reads the Greenhouse JS embed token', () => {
    const html = `<script>Grnhse.Settings = { boardToken: "AcmeCo" };</script>`;
    expect(scanHtml(html, 'https://acme.com/careers')[0]).toMatchObject({ atsType: 'greenhouse', boardToken: 'acmeco' });
  });

  it('flags a custom-domain SuccessFactors RMK site at low confidence', () => {
    const html = `<link rel="stylesheet" href="https://rmkcdn.successfactors.com/84d0a/main.css">`;
    expect(scanHtml(html, 'https://careers.bigbank.com/')).toEqual([
      expect.objectContaining({ atsType: 'successfactors', boardToken: 'careers.bigbank.com', confidence: 0.4 }),
    ]);
  });

  it('decodes entities in attribute URLs', () => {
    const html = `<a href="https://boards.greenhouse.io/embed/job_board?for=zeta&amp;b=1">jobs</a>`;
    expect(scanHtml(html, 'https://zeta.tech/')[0]!.boardToken).toBe('zeta');
  });
});

describe('domain helpers', () => {
  it('normalizes domains', () => {
    expect(normalizeDomain('https://www.Acme.com/careers')).toBe('acme.com');
    expect(normalizeDomain('acme.co.in')).toBe('acme.co.in');
    expect(normalizeDomain('Acme Inc')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
  });
  it('computes registrable domains', () => {
    expect(registrableDomain('careers.acme.com')).toBe('acme.com');
    expect(registrableDomain('jobs.tata.co.in')).toBe('tata.co.in');
  });
  it('derives slug candidates', () => {
    expect(slugCandidates('Walmart Global Tech India')).toEqual(['walmartglobaltech', 'walmart-global-tech', 'walmart']);
    expect(slugCandidates('Razorpay')).toEqual(['razorpay']);
    expect(slugCandidates('AT&T')).toEqual(['atandt', 'at-and-t', 'at']);
  });
  it('picks same-site career links only', () => {
    const html = `<a href="/jobs/search">Open roles</a><a href="https://other.com/careers">x</a><a href="/about">a</a><a href="https://jobs.acme.com/">j</a>`;
    expect(careerLinks(html, 'https://acme.com/careers')).toEqual(['https://acme.com/jobs/search', 'https://jobs.acme.com/']);
  });
});

describe('robots', () => {
  const txt = `
User-agent: *
Disallow: /private
Allow: /private/ok
Disallow: /*.pdf$

User-agent: BadBot
User-agent: JobForge
Disallow: /careers/internal
`;
  it('picks the most specific group and applies longest match', () => {
    const star = parseRobots(txt, 'SomeBot');
    expect(isPathAllowed(star, '/private/x')).toBe(false);
    expect(isPathAllowed(star, '/private/ok/1')).toBe(true);
    expect(isPathAllowed(star, '/files/a.pdf')).toBe(false);
    expect(isPathAllowed(star, '/files/a.pdf?x')).toBe(true);
    const jf = parseRobots(txt, 'JobForge/0.1');
    expect(isPathAllowed(jf, '/private/x')).toBe(true); // its own group replaces '*'
    expect(isPathAllowed(jf, '/careers/internal/1')).toBe(false);
  });

  it('treats 4xx as allow-all, 5xx as disallow-all, errors as unreachable', async () => {
    const statuses: Record<string, number> = { 'https://a.com': 404, 'https://b.com': 503 };
    const cache = new RobotsCache(async (u) => {
      const origin = new URL(u).origin;
      if (origin === 'https://c.com') throw new Error('dns');
      return { status: statuses[origin] ?? 200, body: '' };
    });
    expect(await cache.allowed('https://a.com/careers')).toBe(true);
    expect(await cache.allowed('https://b.com/careers')).toBe(false);
    expect(await cache.allowed('https://c.com/careers')).toBe(false);
    expect(await cache.verdict('https://c.com/careers')).toBe('unreachable');
  });
});

describe('createPageFetcher', () => {
  function fakeFetch(routes: Record<string, { status?: number; body?: string; location?: string; type?: string }>) {
    const calls: string[] = [];
    const fn = (async (input: URL | string) => {
      const url = String(input);
      calls.push(url);
      const r = routes[url];
      if (!r) return new Response('nope', { status: 404 });
      return new Response(r.body ?? '', {
        status: r.status ?? 200,
        headers: { 'content-type': r.type ?? 'text/html', ...(r.location ? { location: r.location } : {}) },
      });
    }) as typeof globalThis.fetch;
    return { fn, calls };
  }

  it('follows redirects, upgrading http, and reports the chain', async () => {
    const { fn } = fakeFetch({
      'https://acme.com/careers': { status: 301, location: 'http://acme.wd5.myworkdayjobs.com/AcmeCareers' },
      'https://acme.wd5.myworkdayjobs.com/AcmeCareers': { body: '<html>workday</html>' },
    });
    const pages = createPageFetcher({ limiter: new DomainRateLimiter(), fetch: fn, rateLimit: { tokens: 100, intervalMs: 1 } });
    const r = await pages.get('https://acme.com/careers');
    expect(r.url).toBe('https://acme.wd5.myworkdayjobs.com/AcmeCareers');
    expect(r.chain).toEqual(['https://acme.com/careers', 'https://acme.wd5.myworkdayjobs.com/AcmeCareers']);
    expect(r.body).toContain('workday');
  });

  it('refuses paths robots.txt disallows (checked per hop)', async () => {
    const { fn, calls } = fakeFetch({
      'https://acme.com/robots.txt': { body: 'User-agent: *\nDisallow: /careers', type: 'text/plain' },
    });
    const pages = createPageFetcher({ limiter: new DomainRateLimiter(), fetch: fn, rateLimit: { tokens: 100, intervalMs: 1 } });
    await expect(pages.get('https://acme.com/careers')).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(calls).toEqual(['https://acme.com/robots.txt']);
  });
});

/** In-memory PageFetcher keyed by URL; redirects are expressed as chains. */
function fakePages(routes: Record<string, Partial<PageResponse> & { redirectTo?: string; blocked?: boolean }>): PageFetcher & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      const r = routes[url];
      if (r?.blocked) throw new RobotsDisallowedError(url);
      if (r?.redirectTo) {
        const target = routes[r.redirectTo];
        return { status: target?.status ?? 200, url: r.redirectTo, chain: [url, r.redirectTo], body: target?.body ?? '', contentType: 'text/html' };
      }
      if (!r) return { status: 404, url, chain: [url], body: '', contentType: 'text/html' };
      return { status: r.status ?? 200, url, chain: [url], body: r.body ?? '', contentType: r.contentType ?? 'text/html' };
    },
  };
}

describe('discoverAts', () => {
  it('a redirect onto an ATS host is conclusive and stops early', async () => {
    const pages = fakePages({
      'https://walmart.com/careers': { redirectTo: 'https://walmart.wd5.myworkdayjobs.com/WalmartExternal' },
    });
    const r = await discoverAts({ pages, log }, { domain: 'www.walmart.com', name: 'Walmart' });
    expect(r.best).toMatchObject({ atsType: 'workday', boardToken: 'walmart.wd5/WalmartExternal', confidence: 1 });
    expect(pages.calls).toEqual(['https://walmart.com/careers']);
  });

  it('scans the careers page, then follows one hop of job links', async () => {
    const pages = fakePages({
      'https://razorpay.com/careers': { body: '<a href="/jobs/openings">See open roles</a>' },
      'https://razorpay.com/jobs/openings': { body: '<a href="https://jobs.lever.co/razorpay/1">SDE</a>' },
    });
    const r = await discoverAts({ pages, log }, { domain: 'razorpay.com' });
    expect(r.best).toMatchObject({ atsType: 'lever', boardToken: 'razorpay' });
    expect(r.visited).toContain('https://razorpay.com/jobs/openings');
  });

  it('records robots blocks and falls back to name probes', async () => {
    const pages = fakePages({
      'https://acme.com/careers': { blocked: true },
      'https://boards-api.greenhouse.io/v1/boards/acme': { body: JSON.stringify({ name: 'Acme', content: '' }) },
    });
    const r = await discoverAts({ pages, log }, { domain: 'acme.com', name: 'Acme' });
    expect(r.robotsBlocked).toEqual(['https://acme.com/careers']);
    expect(r.best).toMatchObject({ atsType: 'greenhouse', boardToken: 'acme', evidence: 'probe:greenhouse', confidence: 0.75 });
  });

  it('probes SmartRecruiters with a capitalized id and ignores empty boards', async () => {
    const pages = fakePages({
      'https://api.smartrecruiters.com/v1/companies/visa/postings?limit=1': { body: JSON.stringify({ totalFound: 0, content: [] }) },
      'https://api.smartrecruiters.com/v1/companies/Visa/postings?limit=1': { body: JSON.stringify({ totalFound: 12, content: [] }) },
    });
    const r = await discoverAts({ pages, log }, { name: 'Visa' });
    expect(r.best).toMatchObject({ atsType: 'smartrecruiters', boardToken: 'Visa' });
  });

  it('returns no detection when nothing matches', async () => {
    const r = await discoverAts({ pages: fakePages({}), log }, { domain: 'nothing.example' }, { probe: false });
    expect(r.best).toBeNull();
    expect(r.detections).toEqual([]);
  });
});
