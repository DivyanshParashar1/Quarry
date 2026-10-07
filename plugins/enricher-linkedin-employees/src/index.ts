import { z } from 'zod';
import {
  assertNotBlocked,
  classifyHeadline,
  defineEnricherPlugin,
  LINKEDIN_HOST,
  parseCompanyId,
  parseCompanySlug,
  parsePeopleSearch,
  peopleSearchUrl,
  type BrowserPage,
  type EmployeeEnrichment,
} from '@jobforge/plugin-sdk';

export const configSchema = z
  .object({
    /** Title keywords for people search; each is one search. */
    keywords: z.array(z.string().min(2)).default(['software engineer', 'SDE', 'developer']),
    /** Stop after this many distinct profiles. */
    maxProfiles: z.number().int().min(1).max(50).default(15),
    /** Result pages per keyword. */
    pagesPerKeyword: z.number().int().min(1).max(5).default(1),
    /** Minimum pause between two searches (LinkedIn is sensitive to bursts). */
    searchIntervalSeconds: z.number().int().min(0).default(60),
  })
  .strict();
export type LinkedInEmployeesConfig = z.infer<typeof configSchema>;

const jitter = (ms: number) => Math.round(ms * (0.85 + Math.random() * 0.3));

/** Small human-ish pause + mouse movement + a scroll, so the page sees a person-paced session. */
async function humanize(page: BrowserPage): Promise<void> {
  await page.mouse.move(200 + Math.random() * 600, 150 + Math.random() * 400, { steps: 8 + Math.floor(Math.random() * 10) });
  await page.waitForTimeout(jitter(1200));
  await page.mouse.wheel(0, 300 + Math.random() * 600);
  await page.waitForTimeout(jitter(900));
}

async function visit(page: BrowserPage, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const html = await page.content();
  assertNotBlocked(page.url(), html, await page.title());
  return html;
}

export default defineEnricherPlugin<LinkedInEmployeesConfig, EmployeeEnrichment>({
  manifest: {
    id: 'enricher-linkedin-employees',
    version: '0.1.0',
    stage: 'enricher',
    description: 'Finds engineers at a company via LinkedIn people search in your logged-in (dedicated) LinkedIn session. Read-only.',
    configSchema,
    permissions: { domains: [LINKEDIN_HOST], browser: true },
    // Every navigation waits on this; searches additionally honour searchIntervalSeconds.
    rateLimit: { perDomain: { tokens: 1, intervalMs: 15_000 } },
    sideEffects: 'none',
  },

  async enrich(ctx, _job, company) {
    const notes: string[] = [];
    const out: EmployeeEnrichment = { linkedinId: company.linkedinId ?? null, linkedinSlug: company.linkedinSlug ?? null, profiles: [], notes };
    if (ctx.dryRun) {
      notes.push('dry run: LinkedIn was not opened');
      return out;
    }
    const page = await ctx.browser!.newPage();
    try {
      if (!out.linkedinId) {
        if (!out.linkedinSlug) {
          const html = await visit(page, `https://${LINKEDIN_HOST}/search/results/companies/?keywords=${encodeURIComponent(company.name)}`);
          out.linkedinSlug = parseCompanySlug(html);
          if (!out.linkedinSlug) {
            notes.push(`no LinkedIn company page found for "${company.name}"`);
            return out;
          }
          await humanize(page);
        }
        out.linkedinId = parseCompanyId(await visit(page, `https://${LINKEDIN_HOST}/company/${out.linkedinSlug}/`));
        if (!out.linkedinId) {
          notes.push(`couldn't read the LinkedIn company id from /company/${out.linkedinSlug}/`);
          return out;
        }
        await humanize(page);
      }

      const seen = new Set(company.contacts.map((c) => c.linkedinUrl).filter(Boolean));
      let searches = 0;
      outer: for (const kw of ctx.config.keywords) {
        for (let p = 1; p <= ctx.config.pagesPerKeyword; p++) {
          if (searches++ > 0) await page.waitForTimeout(jitter(ctx.config.searchIntervalSeconds * 1000));
          const results = parsePeopleSearch(await visit(page, peopleSearchUrl(out.linkedinId, kw, p)));
          await humanize(page);
          for (const r of results) {
            if (seen.has(r.profileUrl)) continue;
            seen.add(r.profileUrl);
            out.profiles.push({ ...r, ...classifyHeadline(r.headline ?? '') });
            if (out.profiles.length >= ctx.config.maxProfiles) break outer;
          }
          if (results.length < 5) break; // last page
        }
      }
      notes.push(`${out.profiles.length} profile(s) from ${searches} search(es)`);
      return out;
    } finally {
      await page.close();
    }
  },
});
