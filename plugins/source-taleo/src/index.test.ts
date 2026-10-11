import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pluginManifestSchema, rawPostingSchema, parseTaleoToken, type HttpRequestInit } from '@quarry/plugin-sdk';
import { collect, fixtureHttp, testContext, testTarget } from '@quarry/plugin-sdk/testing';
import plugin, { classicListUrl, configSchema, findPortalId, parseClassicList, searchApiUrl, searchPageUrl } from './index.js';

const fx = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const fixture = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const domains = plugin.manifest.permissions.domains;
const board = parseTaleoToken('sbi/ex');

function routes() {
  return {
    [searchPageUrl(board)]: { file: fixture('jobsearch.html') },
    [`POST ${searchApiUrl(board, '101430233')}`]: (init: HttpRequestInit) => {
      const { pageNo } = JSON.parse(init.body ?? '{}') as { pageNo: number };
      return { file: fixture(`search-${pageNo}.json`) };
    },
  };
}

describe('source-taleo', () => {
  it('has a valid manifest and parses tokens', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(board).toEqual({ host: 'sbi.taleo.net', tenant: 'sbi', section: 'ex' });
    expect(parseTaleoToken('https://sbi.taleo.net/careersection/2/jobsearch.ftl?lang=en')).toMatchObject({ section: '2' });
  });

  it('finds the portal id in the search page', () => {
    expect(findPortalId('<a href="x.ftl?lang=en&portal=8105120395">')).toBe('8105120395');
    expect(findPortalId('{"portalId": "123456789"}')).toBe('123456789');
    expect(findPortalId('<html></html>')).toBeNull();
  });

  it('discovers the portal and pages through requisitions', async () => {
    const http = fixtureHttp(routes(), domains);
    const postings = await collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('sbi/ex', 'State Bank of India')));
    expect(postings).toHaveLength(29);
    for (const p of postings) expect(rawPostingSchema.safeParse(p).success).toBe(true);
    expect(postings[1]).toMatchObject({
      externalId: '500001',
      title: 'Specialist Cadre Officer - IT',
      locations: ['India, Navi Mumbai', 'India, Hyderabad'],
      url: 'https://sbi.taleo.net/careersection/ex/jobdetail.ftl?job=SBI2601&lang=en',
    });
    expect(postings[0]!.postedAt?.getFullYear()).toBe(2026);
    expect(http.bodies.filter(Boolean).map((b) => (JSON.parse(b!) as { pageNo: number }).pageNo)).toEqual([1, 2]);
  });

  it('uses a configured portal without the discovery request', async () => {
    const http = fixtureHttp(routes(), domains);
    const postings = await collect(
      plugin.fetch(testContext(configSchema.parse({ locations: ['Bengaluru'] }), http), testTarget('sbi/ex', 'SBI', { portal: '101430233' })),
    );
    expect(postings).toHaveLength(4);
    expect(http.calls.some((u) => u.endsWith('jobsearch.ftl?lang=en'))).toBe(false);
  });

  it('explains when neither a portal id nor the classic list is there', async () => {
    const http = fixtureHttp({ [searchPageUrl(board)]: { text: '<html>no portal</html>' }, [`POST ${classicListUrl(board)}`]: { text: '<html>not a list</html>' } }, domains);
    await expect(collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('sbi/ex')))).rejects.toThrow(/neither a REST portal id nor the classic job list/);
  });

  it('classic career sections (recorded from aa224): no portal on the page → the list pager', async () => {
    const aa = parseTaleoToken('aa224/ex');
    expect(findPortalId(readFileSync(fx('aa224-moresearch.html'), 'utf8'))).toBeNull();
    const page1 = readFileSync(fx('aa224-moresearch-page1.txt'), 'utf8');
    const http = fixtureHttp(
      {
        [searchPageUrl(aa)]: { file: fx('aa224-moresearch.html') },
        [`POST ${classicListUrl(aa)}`]: (init) => ({ text: String(init.body).includes('rlPager.currentPage=1') ? page1 : '?!|!ftlPager_processResponse!$!' }),
      },
      domains,
    );
    const postings = await collect(plugin.fetch(testContext(configSchema.parse({}), http), testTarget('aa224/ex', 'American Airlines')));
    expect(postings).toHaveLength(25);
    expect(postings[0]).toMatchObject({
      externalId: '12765379',
      title: 'CDL A Delivery Truck Driver',
      url: 'https://aa224.taleo.net/careersection/ex/jobdetail.ftl?job=JR108790&lang=en',
      locations: ['United States, South Carolina, Columbia'],
    });
    const parsed = parseClassicList(page1);
    expect(parsed).toMatchObject({ total: 753, pageSize: 25 });
    expect(http.bodies.filter(Boolean).map((b) => new URLSearchParams(b).get('rlPager.currentPage'))).toEqual(['1', '2']);
  });
});
