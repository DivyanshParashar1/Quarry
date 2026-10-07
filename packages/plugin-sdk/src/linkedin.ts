import { decodeEntities } from './html.js';
import { SessionBlockedError } from './browser.js';

// Helpers shared by the LinkedIn plugins (employee search, referral actor,
// tracker). LinkedIn automation is opt-in, runs on a dedicated account, and
// stops at the first sign of a challenge page.

export const LINKEDIN_HOST = 'www.linkedin.com';

/** Canonical `https://www.linkedin.com/in/<slug>/` (no query, no locale). */
export function canonicalProfileUrl(raw: string): string | null {
  const m = raw.match(/linkedin\.com\/in\/([^/?#"'\s]+)/i);
  if (!m) return null;
  return `https://${LINKEDIN_HOST}/in/${decodeURIComponent(m[1]!).toLowerCase()}/`;
}

const BLOCK_URL: [RegExp, string][] = [
  [/\/checkpoint\/challenge|\/checkpoint\/lg|captcha/i, 'captcha'],
  [/\/checkpoint\//i, 'checkpoint'],
  [/\/authwall|\/login|\/uas\/login|\/signup/i, 'login'],
];

const BLOCK_TEXT: [RegExp, string][] = [
  [/let['’]?s do a quick security check|security verification|verify you['’]?re (a )?human|captcha/i, 'captcha'],
  [/we['’]?ve restricted your account|your account has been restricted|account (is )?temporarily restricted/i, 'restricted'],
  [/you['’]?ve reached the weekly invitation limit|weekly limit for invitations|too many requests|unusual activity/i, 'rate_limited'],
  [/sign in to (view|see)|join linkedin to|welcome back.*sign in/i, 'login'],
];

/**
 * Throw SessionBlockedError when a page is a challenge, login wall, account
 * restriction or limit notice (including LinkedIn's HTTP 999 "security check").
 */
export function assertNotBlocked(url: string, html: string, title = ''): void {
  for (const [re, reason] of BLOCK_URL) if (re.test(url)) throw new SessionBlockedError(`LinkedIn ${reason} page at ${url}`, reason, url);
  const text = `${title}\n${html.slice(0, 200_000)}`;
  if (/\b999\b/.test(title) || /request denied.*999|status code 999/i.test(text)) {
    throw new SessionBlockedError('LinkedIn returned a 999 security check', 'captcha', url);
  }
  for (const [re, reason] of BLOCK_TEXT) if (re.test(text)) throw new SessionBlockedError(`LinkedIn ${reason} notice at ${url}`, reason, url);
}

export type RoleHint = 'engineer' | 'manager' | 'leader' | 'recruiter' | 'other';
export type SeniorityHint = 'junior' | 'mid' | 'senior' | 'staff' | 'exec';

/** Classify a headline like "Senior Software Engineer - Payments at Walmart Global Tech". */
export function classifyHeadline(headline: string): { roleHint: RoleHint; seniorityHint: SeniorityHint; department: string | null } {
  const h = headline.toLowerCase();
  let roleHint: RoleHint = 'other';
  if (/recruit|talent acquisition|talent partner|hiring|\bhr\b|people partner|sourcer/.test(h)) roleHint = 'recruiter';
  else if (/\b(vp|vice president|cto|chief|head of|director)\b/.test(h)) roleHint = 'leader';
  else if (/manager|\blead\b|team lead/.test(h) && /engineer|develop|software|tech|product|data/.test(h)) roleHint = 'manager';
  else if (/engineer|developer|\bsde\b|\bswe\b|programmer|architect|scientist|devops|\bsre\b/.test(h)) roleHint = 'engineer';
  let seniorityHint: SeniorityHint = 'mid';
  if (/\b(vp|vice president|cto|chief|director|head of)\b/.test(h)) seniorityHint = 'exec';
  else if (/\b(staff|principal|distinguished|architect)\b/.test(h)) seniorityHint = 'staff';
  else if (/\b(senior|sr\.?|lead|iii|3)\b/.test(h)) seniorityHint = 'senior';
  else if (/\b(intern|trainee|graduate|associate|junior|jr\.?|i)\b|\bsde[- ]?1\b/.test(h)) seniorityHint = 'junior';
  const dept = headline.match(/[-–|,(]\s*([A-Z][\w&/ ]{2,40}?)\s*(?:team)?\s*\)?\s*(?:@|\bat\b|$)/);
  const department = dept?.[1] && !/\b(at|engineer|developer)\b/i.test(dept[1]) ? dept[1].trim() : null;
  return { roleHint, seniorityHint, department };
}

export interface LinkedInPersonResult {
  name: string;
  headline: string | null;
  location: string | null;
  profileUrl: string;
}

const NOISE_LINE = /^(view .*profile|•?\s*(1st|2nd|3rd\+?)( degree connection)?|connect|message|follow|pending|status is (online|offline|reachable)|current:.*|past:.*|\d+ (mutual|other) connections?|.*mutual connections?|linkedin member|premium|open to work|provides services.*|•)$/i;

/** People-search result rows from a search page's HTML. "LinkedIn Member" (out-of-network) rows are skipped. */
export function parsePeopleSearch(html: string): LinkedInPersonResult[] {
  const out: LinkedInPersonResult[] = [];
  const seen = new Set<string>();
  const re = /href="([^"]*linkedin\.com\/in\/[^"]+|\/in\/[^"]+)"/gi;
  const hits = [...html.matchAll(re)];
  for (let i = 0; i < hits.length; i++) {
    const url = canonicalProfileUrl(hits[i]![1]!.startsWith('/') ? `https://${LINKEDIN_HOST}${hits[i]![1]}` : hits[i]![1]!);
    if (!url || seen.has(url)) continue;
    // The row runs until the next different profile link.
    let end = html.length;
    for (let j = i + 1; j < hits.length; j++) {
      const next = canonicalProfileUrl(hits[j]![1]!.startsWith('/') ? `https://${LINKEDIN_HOST}${hits[j]![1]}` : hits[j]![1]!);
      if (next && next !== url) {
        end = html.lastIndexOf('<', hits[j]!.index!);
        break;
      }
    }
    // Start at the tag that holds the href, so no attribute text leaks into the lines.
    const segment = html.slice(Math.max(0, html.lastIndexOf('<', hits[i]!.index!)), end);
    const hidden = segment.match(/aria-hidden="true"[^>]*>([^<]{2,80})</);
    const lines = segment
      .replace(/<span class="visually-hidden">[\s\S]*?<\/span>/gi, '\n')
      .replace(/<(br|\/div|\/span|\/p|\/li|\/a)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map((l) => decodeEntities(l).replace(/\s+/g, ' ').trim())
      .filter((l) => l && !NOISE_LINE.test(l));
    const name = decodeEntities(hidden?.[1] ?? lines[0] ?? '').trim();
    if (!name || /linkedin member/i.test(name)) continue;
    const rest = lines.filter((l) => l !== name);
    seen.add(url);
    out.push({ name, headline: rest[0] ?? null, location: rest[1] ?? null, profileUrl: url });
  }
  return out;
}

/** The numeric company id from a company page or search page (needed for currentCompany= filters). */
export function parseCompanyId(html: string): string | null {
  return (
    html.match(/urn:li:fsd_company:(\d+)/)?.[1] ??
    html.match(/urn:li:(?:organization|company):(\d+)/)?.[1] ??
    html.match(/currentCompany=(?:%5B%22|\["|\[%22)(\d+)/i)?.[1] ??
    html.match(/[?&]f_C=(\d+)/)?.[1] ??
    null
  );
}

/** First company slug in a companies search page. */
export function parseCompanySlug(html: string): string | null {
  return html.match(/linkedin\.com\/company\/([^/?#"]+)/i)?.[1] ?? html.match(/href="\/company\/([^/?#"]+)/i)?.[1] ?? null;
}

export function peopleSearchUrl(companyId: string, keywords: string, page = 1): string {
  const q = new URLSearchParams({ currentCompany: `["${companyId}"]`, keywords, origin: 'FACETED_SEARCH', ...(page > 1 ? { page: String(page) } : {}) });
  return `https://${LINKEDIN_HOST}/search/results/people/?${q.toString()}`;
}
