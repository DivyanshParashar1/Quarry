import { z } from 'zod';
import type { LLMClient, Logger } from '@jobforge/shared';
import { normalizeDomain } from './detect.js';
import type { PageFetcher } from './page-fetcher.js';

/** A company found on a public list, before ATS detection. */
export interface CompanyCandidate {
  name: string;
  domain: string | null;
  location: string | null;
  tags: string[];
}

export interface ListDeps {
  pages: PageFetcher;
  llm?: LLMClient | undefined;
  log: Logger;
}

export interface ListSettings {
  urls?: string[] | undefined;
  regions?: string[] | undefined;
}

export interface CompanyListSource {
  id: string;
  description: string;
  /** True when the list needs an LLM to extract companies from page text. */
  needsLlm: boolean;
  defaultUrls: string[];
  collect(deps: ListDeps, settings: ListSettings): Promise<CompanyCandidate[]>;
}

// ---------------------------------------------------------------------------
// YC (structured JSON; no LLM)
// ---------------------------------------------------------------------------

const ycCompany = z
  .object({
    name: z.string(),
    website: z.string().nullable().optional(),
    all_locations: z.string().nullable().optional(),
    regions: z.array(z.string()).nullable().optional(),
    isHiring: z.boolean().nullable().optional(),
    status: z.string().nullable().optional(),
    batch: z.string().nullable().optional(),
    industry: z.string().nullable().optional(),
  })
  .passthrough();

export const ycList: CompanyListSource = {
  id: 'yc',
  description: 'Y Combinator companies that are hiring (yc-oss static API, filtered by region).',
  needsLlm: false,
  defaultUrls: ['https://yc-oss.github.io/api/companies/all.json'],
  async collect(deps, settings) {
    const regions = (settings.regions ?? ['India', 'Remote']).map((r) => r.toLowerCase());
    const out: CompanyCandidate[] = [];
    for (const url of settings.urls ?? this.defaultUrls) {
      const page = await deps.pages.get(url, { accept: 'application/json', maxBytes: 64_000_000 });
      if (page.status !== 200) throw new Error(`${url} -> ${page.status}`);
      const parsed = z.array(z.unknown()).parse(JSON.parse(page.body));
      for (const raw of parsed) {
        const c = ycCompany.safeParse(raw);
        if (!c.success) continue;
        const d = c.data;
        if (d.isHiring === false) continue;
        if (d.status && !/^(active|public)$/i.test(d.status.trim())) continue;
        const hay = [...(d.regions ?? []), d.all_locations ?? ''].join(' ').toLowerCase();
        if (regions.length && !regions.some((r) => hay.includes(r))) continue;
        out.push({
          name: d.name.trim(),
          domain: d.website ? normalizeDomain(d.website) : null,
          location: d.all_locations ?? null,
          tags: ['startup', 'yc', ...(d.batch ? [`yc-${d.batch.toLowerCase().replace(/\s+/g, '')}`] : [])],
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// LLM-extracted lists (GCC Journal, Wellfound, Internshala, Hirect)
// ---------------------------------------------------------------------------

const extracted = z.object({
  companies: z
    .array(
      z.object({
        name: z.string().min(1),
        domain: z.string().nullable(),
        location: z.string().nullable(),
      }),
    )
    .max(400),
});

const EXTRACT_SYSTEM = `You extract employer names from the text of a web page that lists companies.
Return only companies that the page itself names as employers (not ads, navigation, sponsors, or the publisher).
Use the company's own name (drop suffixes like "India Pvt Ltd" only when the parent brand is obvious).
Fill "domain" only when the page shows the company's website or it is unambiguous (e.g. walmart.com); otherwise null.
Never invent companies.`;

/** Strip tags/scripts and collapse whitespace; keeps link hosts, which often carry the company domain. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\b[^>]*href=["']https?:\/\/(?:www\.)?([^/"']+)[^"']*["'][^>]*>/gi, ' [$1] ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** ~12k-char chunks on line boundaries so one LLM call stays cheap. */
export function chunkText(text: string, size = 12_000): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > size && cur) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line.slice(0, size);
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

function llmList(id: string, description: string, defaultUrls: string[], tags: string[]): CompanyListSource {
  return {
    id,
    description,
    needsLlm: true,
    defaultUrls,
    async collect(deps, settings) {
      if (!deps.llm) throw new Error(`list ${id} needs an LLM client for extraction`);
      const out: CompanyCandidate[] = [];
      for (const url of settings.urls ?? defaultUrls) {
        const page = await deps.pages.get(url);
        if (page.status !== 200) {
          deps.log.warn({ url, status: page.status }, 'discovery list page not available');
          continue;
        }
        for (const chunk of chunkText(htmlToText(page.body))) {
          const r = await deps.llm.generate({
            task: 'extract',
            system: EXTRACT_SYSTEM,
            prompt: `Page: ${page.url}\n\n${chunk}`,
            schema: extracted,
            maxTokens: 4000,
          });
          for (const c of r.data.companies) {
            out.push({
              name: c.name.trim(),
              domain: c.domain ? normalizeDomain(c.domain) : null,
              location: c.location,
              tags,
            });
          }
        }
      }
      return out;
    },
  };
}

export const gccJournalList = llmList(
  'gcc-journal',
  'Global Capability Centres in India (gccjournal.in directory), LLM-extracted.',
  ['https://gccjournal.in/insights/list-of-global-capability-centers-gcc-in-india/'],
  ['gcc'],
);

export const wellfoundList = llmList(
  'wellfound',
  'Wellfound startup directory pages for India, LLM-extracted (often bot-protected; failures are logged).',
  ['https://wellfound.com/startups/location/india'],
  ['startup'],
);

export const internshalaList = llmList(
  'internshala',
  'Companies posting on Internshala (public internship listing pages), LLM-extracted.',
  ['https://internshala.com/internships/computer-science-internship'],
  ['startup', 'internships'],
);

export const hirectList = llmList(
  'hirect',
  'Hirect India company listings, LLM-extracted.',
  ['https://hirect.in/companies'],
  ['startup'],
);

export const COMPANY_LISTS: Record<string, CompanyListSource> = {
  yc: ycList,
  'gcc-journal': gccJournalList,
  wellfound: wellfoundList,
  internshala: internshalaList,
  hirect: hirectList,
};

/** Merge duplicates inside one batch: same domain, else same case-folded name. */
export function dedupeCandidates(cands: CompanyCandidate[]): CompanyCandidate[] {
  const byKey = new Map<string, CompanyCandidate>();
  const nameKey = (n: string) => `name:${n.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  for (const c of cands) {
    if (!c.name.trim()) continue;
    const key = c.domain ? `domain:${c.domain}` : nameKey(c.name);
    const alt = nameKey(c.name);
    const existing = byKey.get(key) ?? byKey.get(alt);
    if (existing) {
      existing.domain ??= c.domain;
      existing.location ??= c.location;
      existing.tags = [...new Set([...existing.tags, ...c.tags])];
      continue;
    }
    const copy = { ...c, tags: [...c.tags] };
    byKey.set(key, copy);
    if (key !== alt) byKey.set(alt, copy);
  }
  return [...new Set(byKey.values())];
}
