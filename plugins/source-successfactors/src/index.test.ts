import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError, pluginManifestSchema, rawPostingSchema, sanitizeHtml } from '@jobforge/plugin-sdk';
import { collect, fixtureHttp, testContext, testTarget, type FixtureRouteSpec } from '@jobforge/plugin-sdk/testing';
import plugin, { classicFeedUrl, configSchema, rmkSearchUrl } from './index.js';

const fixture = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const domains = plugin.manifest.permissions.domains;
const classic = { kind: 'classic' as const, host: 'career4.successfactors.com', companyId: 'bigbankP' };

describe('sanitizeHtml', () => {
  it('drops styles, fonts, spans, Office markup and attributes but keeps structure', () => {
    expect(
      sanitizeHtml('<p style="x" class="MsoNormal"><span style="y"><b>Hi</b></span><o:p></o:p></p><!--[if mso]>x<![endif]--><font face="A">there</font><a href="https://x.com" onclick="evil()">l</a><script>bad()</script>'),
    ).toBe('<p><b>Hi</b></p>there<a href="https://x.com">l</a>');
  });
});

describe('source-successfactors', () => {
  it('has a valid manifest', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
  });

  it('parses the classic XML feed with sanitised descriptions', async () => {
    const http = fixtureHttp({ [classicFeedUrl(classic)]: { file: fixture('classic-feed.xml') } }, domains);
    const postings = await collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('career4.successfactors.com/bigbankP')));
    expect(postings).toHaveLength(3);
    for (const p of postings) expect(rawPostingSchema.safeParse(p).success).toBe(true);
    expect(postings[0]).toMatchObject({
      externalId: '10234',
      title: 'Graduate Engineer Trainee - IT',
      locations: ['Mumbai, IN'],
      department: 'Technology',
      descriptionHtml: '<p><b>About the role</b></p><p>Work on core banking systems.</p><ul><li>Java</li><li>SQL</li></ul>',
    });
    expect(postings[0]!.url).toContain('career_job_req_id=10234');
    expect(postings[1]).toMatchObject({ title: 'Software Engineer & Analyst', locations: ['Chennai, India'], descriptionHtml: '<p>Payments platform.</p>' });
    expect(postings[0]!.postedAt?.toISOString().slice(0, 10)).toBe('2026-09-20');
  });

  it('filters the classic feed by location', async () => {
    const http = fixtureHttp({ [classicFeedUrl(classic)]: { file: fixture('classic-feed.xml') } }, domains);
    const postings = await collect(
      plugin.fetch(testContext(configSchema.parse({ locations: ['IN', 'India'] }), http), testTarget('career4.successfactors.com/bigbankP')),
    );
    expect(postings.map((p) => p.externalId)).toEqual(['10234', '10240']);
  });

  it('pages through an RMK site and reads job pages', async () => {
    const host = 'jobs.acme.sapsf.com';
    const routes: Record<string, FixtureRouteSpec> = {
      [rmkSearchUrl(host, 0)]: { file: fixture('rmk-search-0.html') },
      [rmkSearchUrl(host, 25)]: { file: fixture('rmk-search-25.html') },
    };
    // every job page serves the same fixture
    for (const f of ['rmk-search-0.html', 'rmk-search-25.html']) {
      for (const m of readFileSync(fixture(f), 'utf8').matchAll(/href="(\/job\/[^"]+)"/g)) {
        routes[`https://${host}${m[1]}`] = { file: fixture('rmk-job.html') };
      }
    }
    const http = fixtureHttp(routes, domains);
    const postings = await collect(plugin.fetch(testContext(configSchema.parse({ locations: ['IN'] }), http), testTarget(host)));
    expect(postings).toHaveLength(18); // 27 rows, every third in Walldorf
    expect(postings[0]).toMatchObject({
      externalId: '4100001',
      title: 'Software Engineer - Cloud',
      locations: ['Bangalore, IN'],
      url: 'https://jobs.acme.sapsf.com/job/Bangalore-Software-Engineer---Cloud/4100001/',
    });
    expect(postings[0]!.descriptionHtml).toBe("<p><b>What you'll build</b></p><p>HANA services in Go and Java.</p><ul><li>Kubernetes</li></ul>");
    expect(postings.some((p) => p.title === 'Intern - Development (2027)')).toBe(true);
  });

  it('rejects malformed tokens permanently and unknown layouts loudly', async () => {
    const err = await collect(plugin.fetch(testContext(configSchema.parse({})), testTarget('example.com'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).permanent).toBe(true);
    const http = fixtureHttp({ [rmkSearchUrl('jobs.x.sapsf.com', 0)]: { text: '<html>maintenance</html>' } }, domains);
    await expect(collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('jobs.x.sapsf.com')))).rejects.toThrow(/no job rows/);
  });
});
