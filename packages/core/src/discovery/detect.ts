import {
  decodeEntities,
  formatSuccessFactorsToken,
  formatTaleoToken,
  formatWorkdayToken,
  parseSuccessFactorsToken,
  parseTaleoToken,
  parseWorkdayUrl,
} from '@jobforge/plugin-sdk';
import type { AtsType } from '@jobforge/db';

/** One ATS board found for a company, with the evidence that pointed at it. */
export interface AtsDetection {
  atsType: AtsType;
  boardToken: string;
  /** Where we saw it: the URL that redirected / linked / embedded it, or `probe:<api>`. */
  evidence: string;
  /** 1 = the careers page redirected to the board; lower for links and name probes. */
  confidence: number;
}

// Path segments that are never board tokens.
const RESERVED = new Set(['embed', 'v1', 'v0', 'api', 'jobs', 'job', 'static', 'assets', 'careers', 'search']);

/**
 * Classify one URL. Returns the ATS board it points at, or null. Pure; no I/O.
 * Hosts: boards.greenhouse.io / job-boards.greenhouse.io / boards-api.greenhouse.io,
 * jobs.lever.co / api.lever.co, jobs.ashbyhq.com / api.ashbyhq.com,
 * *.myworkdayjobs.com / *.myworkdaysite.com, jobs|careers.smartrecruiters.com /
 * api.smartrecruiters.com, career*.successfactors.com / *.sapsf.com, *.taleo.net.
 */
export function classifyUrl(raw: string): Omit<AtsDetection, 'evidence' | 'confidence'> | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const first = segs[0];
  const tokenOk = (t: string | undefined | null): t is string => !!t && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t) && !RESERVED.has(t.toLowerCase());

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host === 'job-boards.eu.greenhouse.io') {
    const forParam = u.searchParams.get('for');
    if (tokenOk(forParam)) return { atsType: 'greenhouse', boardToken: forParam.toLowerCase() };
    if (tokenOk(first)) return { atsType: 'greenhouse', boardToken: first.toLowerCase() };
    return null;
  }
  if (host === 'boards-api.greenhouse.io' && segs[0] === 'v1' && segs[1] === 'boards' && tokenOk(segs[2])) {
    return { atsType: 'greenhouse', boardToken: segs[2].toLowerCase() };
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    return tokenOk(first) ? { atsType: 'lever', boardToken: first.toLowerCase() } : null;
  }
  if (host === 'api.lever.co' && segs[0] === 'v0' && segs[1] === 'postings' && tokenOk(segs[2])) {
    return { atsType: 'lever', boardToken: segs[2].toLowerCase() };
  }
  if (host === 'jobs.ashbyhq.com') return tokenOk(first) ? { atsType: 'ashby', boardToken: first } : null;
  if (host === 'api.ashbyhq.com' && segs[0] === 'posting-api' && segs[1] === 'job-board' && tokenOk(segs[2])) {
    return { atsType: 'ashby', boardToken: segs[2] };
  }
  if (host.endsWith('.myworkdayjobs.com') || host.endsWith('.myworkdaysite.com')) {
    try {
      return { atsType: 'workday', boardToken: formatWorkdayToken(parseWorkdayUrl(u)) };
    } catch {
      return null;
    }
  }
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') {
    return tokenOk(first) ? { atsType: 'smartrecruiters', boardToken: first } : null;
  }
  if (host === 'api.smartrecruiters.com' && segs[0] === 'v1' && segs[1] === 'companies' && tokenOk(segs[2])) {
    return { atsType: 'smartrecruiters', boardToken: segs[2] };
  }
  if (/successfactors\.(com|eu)$|sapsf\.(com|eu)$/.test(host)) {
    // rmkcdn.* and api hosts are assets, not boards.
    if (/^(rmkcdn|performancemanager\d*|api\d*)\./.test(host)) return null;
    try {
      return { atsType: 'successfactors', boardToken: formatSuccessFactorsToken(parseSuccessFactorsToken(u.href)) };
    } catch {
      return null;
    }
  }
  if (host.endsWith('.taleo.net')) {
    try {
      return { atsType: 'taleo', boardToken: formatTaleoToken(parseTaleoToken(u.href)) };
    } catch {
      return null;
    }
  }
  return null;
}

const URL_IN_HTML = /(?:href|src|action|data-src|data-url)\s*=\s*["']([^"']+)["']|(https?:\/\/[^\s"'<>()\\]+)/gi;

/** Every absolute or relative URL referenced in a page (attributes and bare URLs in scripts). */
export function extractUrls(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(URL_IN_HTML)) {
    const raw = decodeEntities((m[1] ?? m[2] ?? '').trim());
    if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(raw)) continue;
    try {
      out.add(new URL(raw, baseUrl).href);
    } catch {
      /* not a URL */
    }
  }
  return [...out];
}

/** Greenhouse's JS embed (`Grnhse.Settings.boardToken`) and similar inline configs. */
const INLINE_TOKENS: [AtsType, RegExp][] = [
  ['greenhouse', /grnhse[\s\S]{0,200}?(?:boardToken|for)\s*[:=]\s*["']([A-Za-z0-9_-]+)["']/i],
  ['lever', /lever[\s\S]{0,80}?(?:accountName|site)\s*[:=]\s*["']([A-Za-z0-9_-]+)["']/i],
];

/** Signals that a custom-domain careers site is a SuccessFactors RMK site. */
const RMK_SIGNATURE = /rmkcdn\.successfactors\.com|jobs2web|j2w\.(?:init|apply)/i;

/**
 * Scan a careers page for ATS boards: links, embeds, scripts, inline configs.
 * Results are de-duplicated and sorted by how often each board is referenced.
 */
export function scanHtml(html: string, pageUrl: string): AtsDetection[] {
  const counts = new Map<string, { d: Omit<AtsDetection, 'evidence' | 'confidence'>; n: number }>();
  const bump = (d: Omit<AtsDetection, 'evidence' | 'confidence'>) => {
    const k = `${d.atsType}:${d.boardToken}`;
    const cur = counts.get(k);
    if (cur) cur.n++;
    else counts.set(k, { d, n: 1 });
  };
  for (const url of extractUrls(html, pageUrl)) {
    const d = classifyUrl(url);
    if (d) bump(d);
  }
  for (const [atsType, re] of INLINE_TOKENS) {
    const m = html.match(re);
    if (m?.[1]) bump({ atsType, boardToken: atsType === 'greenhouse' || atsType === 'lever' ? m[1].toLowerCase() : m[1] });
  }
  const found = [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .map(({ d, n }) => ({ ...d, evidence: pageUrl, confidence: Math.min(0.9, 0.6 + 0.1 * n) }));
  if (!found.length && RMK_SIGNATURE.test(html)) {
    // A SuccessFactors RMK site on the company's own domain. The source plugin
    // can only reach SAP-hosted RMK sites, so record it for a human to map.
    const host = new URL(pageUrl).hostname;
    found.push({ atsType: 'successfactors', boardToken: host, evidence: `${pageUrl} (rmk signature)`, confidence: 0.4 });
  }
  return found;
}

/** Same-site links that probably lead to the actual job list (one hop deeper). */
export function careerLinks(html: string, pageUrl: string, max = 3): string[] {
  const site = registrableDomain(new URL(pageUrl).hostname);
  const out: string[] = [];
  for (const url of extractUrls(html, pageUrl)) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || registrableDomain(u.hostname) !== site) continue;
    if (u.href === pageUrl || !/(jobs|careers|openings|positions|opportunities|vacancies|join)/i.test(u.pathname + u.hostname)) continue;
    if (/\.(pdf|png|jpe?g|svg|css|js)$/i.test(u.pathname)) continue;
    if (!out.includes(u.href)) out.push(u.href);
    if (out.length >= max) break;
  }
  return out;
}

const TWO_LEVEL_TLDS = new Set(['co.in', 'co.uk', 'com.au', 'co.jp', 'com.sg', 'com.br', 'net.in', 'org.in', 'firm.in', 'gen.in']);

/** Good-enough eTLD+1 (no public-suffix list dependency). */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return TWO_LEVEL_TLDS.has(last2) ? parts.slice(-3).join('.') : last2;
}

/** Normalise user input ("https://www.Acme.com/careers") to a bare domain ("acme.com"). */
export function normalizeDomain(input: string): string | null {
  const t = input.trim().toLowerCase();
  if (!t || /\s/.test(t)) return null;
  let host: string;
  try {
    host = new URL(/^https?:\/\//.test(t) ? t : `https://${t}`).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host.replace(/^www\./, '');
}

/** Board-token guesses from a company name: "Walmart Global Tech" → walmartglobaltech, walmart-global-tech, walmart. */
export function slugCandidates(name: string): string[] {
  const words = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|company|technologies|technology|labs|india|gcc)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  const out = [words.join(''), words.join('-'), words[0]!];
  return [...new Set(out)].filter((s) => s.length >= 2);
}
