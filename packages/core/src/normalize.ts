import { createHash } from 'node:crypto';
import { decodeEntities, type RawPosting, type RemotePolicy } from '@jobforge/plugin-sdk';

export interface NormalizedJob {
  title: string;
  normalizedTitle: string;
  locations: string[];
  remotePolicy: RemotePolicy | null;
  seniority: Seniority | null;
  descriptionMd: string | null;
  applyUrl: string | null;
  postedAt: Date | null;
  fingerprint: string;
}

export function normalizePosting(raw: RawPosting, companyName: string): NormalizedJob {
  const title = collapse(decodeEntities(raw.title));
  const locations = dedupe(
    raw.locations.map((l) => collapse(decodeEntities(l))).filter((l) => l && !PLACEHOLDER_LOCATION.test(l)),
  );
  const remotePolicy = raw.remotePolicy ?? (locations.some((l) => /\bremote\b/i.test(l)) ? 'remote' : null);
  const normalizedTitle = normalizeTitle(title);
  return {
    title,
    normalizedTitle,
    locations,
    remotePolicy,
    seniority: inferSeniority(title),
    descriptionMd: raw.descriptionHtml ? htmlToMarkdown(raw.descriptionHtml) || null : null,
    applyUrl: raw.applyUrl ?? raw.url,
    postedAt: raw.postedAt,
    fingerprint: fingerprint(companyName, normalizedTitle, locations[0] ?? (remotePolicy === 'remote' ? 'remote' : '')),
  };
}

const PLACEHOLDER_LOCATION = /^(n\/?a|tbd|tba|none|unknown|-+|\.)$/i;

/** PLAN.md §7: hash(normalized company + normalized title + primary location). */
export function fingerprint(company: string, normalizedTitle: string, primaryLocation: string): string {
  const key = [normalizeCompanyName(company), normalizedTitle, normalizeLocation(primaryLocation)].join('|');
  return createHash('sha256').update(key).digest('hex');
}

const TITLE_ABBREVIATIONS: [RegExp, string][] = [
  [/\bsr\b\.?/g, 'senior'],
  [/\bjr\b\.?/g, 'junior'],
  [/\bmgr\b\.?/g, 'manager'],
  [/\bengr?\b\.?/g, 'engineer'],
  [/\bdev\b/g, 'developer'],
  [/\bswe\b/g, 'software engineer'],
];

export function normalizeTitle(title: string): string {
  let t = decodeEntities(title).toLowerCase();
  t = t.replace(/\((?:m|f|w|d|x|h)(?:\s*\/\s*(?:m|f|w|d|x|h))+\)/g, ' '); // (m/f/d), (h/f)
  for (const [re, rep] of TITLE_ABBREVIATIONS) t = t.replace(re, rep);
  t = t.replace(/[^a-z0-9+#]+/g, ' ');
  return collapse(t);
}

const COMPANY_SUFFIXES = /\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|pvt|private|technologies|labs)\b/g;

export function normalizeCompanyName(name: string): string {
  return collapse(
    decodeEntities(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(COMPANY_SUFFIXES, ' '),
  );
}

const REGIONAL_WORDS = /\b(india|bharat|gcc|global capability (center|centre)|(technology|development|innovation|engineering) (center|centre)|r d)\b/g;

/**
 * Looser key for matching an employer named in a job alert ("Walmart Global
 * Tech India", "Target Corporation India") to a company we already track.
 */
export function companyMatchKey(name: string): string {
  return collapse(normalizeCompanyName(name).replace(REGIONAL_WORDS, ' '));
}

export function normalizeLocation(loc: string): string {
  return collapse(
    decodeEntities(loc)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' '),
  );
}

export type Seniority =
  | 'intern'
  | 'junior'
  | 'senior'
  | 'staff'
  | 'principal'
  | 'lead'
  | 'manager'
  | 'director'
  | 'executive';

const SENIORITY_RULES: [RegExp, Seniority][] = [
  [/\b(intern|internship|co-?op|apprentice)\b/, 'intern'],
  [/\b(vp|vice president|chief|cto|ceo|cfo|head of)\b/, 'executive'],
  [/\bdirector\b/, 'director'],
  [/\bmanager\b/, 'manager'],
  [/\bprincipal\b/, 'principal'],
  [/\bstaff\b/, 'staff'],
  [/\b(lead|tech lead)\b/, 'lead'],
  [/\bsenior\b|\b(iii|iv)\b/, 'senior'],
  [/\b(junior|entry level|new grad|graduate|early career)\b|\bi\b$/, 'junior'],
];

/** Heuristic from the title only. Returns null when nothing matches (usually mid-level). */
export function inferSeniority(title: string): Seniority | null {
  const t = normalizeTitle(title);
  for (const [re, level] of SENIORITY_RULES) if (re.test(t)) return level;
  return null;
}

/** Minimal HTML → markdown for job descriptions. Not a general converter. */
export function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => {
    const text = collapse(stripTags(inner));
    return text ? `\n\n${'#'.repeat(Math.min(Number(n) + 1, 6))} ${text}\n\n` : '';
  });
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = collapse(stripTags(inner));
    return text ? `[${text}](${href})` : '';
  });
  s = s
    .replace(/<(strong|b)(\s[^>]*)?>\s*([\s\S]*?)\s*<\/\1>/gi, (_m, _t, _a, inner: string) =>
      inner.trim() ? `**${inner}**` : '',
    )
    .replace(/<(em|i)(\s[^>]*)?>\s*([\s\S]*?)\s*<\/\1>/gi, (_m, _t, _a, inner: string) =>
      inner.trim() ? `_${inner}_` : '',
    )
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|ul|ol|section|article|table|tr|blockquote)\b[^>]*>/gi, '\n\n');
  s = decodeEntities(stripTags(s)).replace(/\u00a0/g, ' ');
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n(- [^\n]*)\n\n(?=- )/g, '\n$1\n') // keep list items tight
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
