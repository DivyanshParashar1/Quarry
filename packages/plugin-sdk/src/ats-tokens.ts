// ATS board-token formats shared by source plugins and the core ATS detector.

/**
 * A Workday board is identified by (host, tenant, site). We store it in
 * `company_sources.board_token` in one of two compact forms:
 *
 *   `walmart.wd5/WalmartExternal`                 -> walmart.wd5.myworkdayjobs.com, tenant walmart
 *   `wd3.myworkdaysite.com/acme/AcmeCareers`      -> shared-host tenants (…/recruiting/acme/AcmeCareers)
 *
 * Full careers URLs are accepted too and normalised to one of these forms.
 */
export interface WorkdayBoard {
  host: string;
  tenant: string;
  site: string;
}

const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

export function parseWorkdayToken(raw: string): WorkdayBoard {
  const token = raw.trim();
  if (/^https?:\/\//i.test(token)) return parseWorkdayUrl(new URL(token));

  const parts = token.split('/').filter(Boolean);
  if (parts.length === 2 && /^[a-z0-9-]+\.wd\d+$/i.test(parts[0]!)) {
    const sub = parts[0]!.toLowerCase();
    return { host: `${sub}.myworkdayjobs.com`, tenant: sub.split('.')[0]!, site: parts[1]! };
  }
  if (parts.length === 3 && /\.myworkdaysite\.com$/i.test(parts[0]!)) {
    return { host: parts[0]!.toLowerCase(), tenant: parts[1]!, site: parts[2]! };
  }
  throw new Error(`invalid Workday board token "${raw}" (expected "tenant.wdN/Site")`);
}

export function parseWorkdayUrl(url: URL): WorkdayBoard {
  const host = url.hostname.toLowerCase();
  const segs = url.pathname.split('/').filter(Boolean);
  if (host.endsWith('.myworkdayjobs.com')) {
    const tenant = host.split('.')[0]!;
    // /wday/cxs/{tenant}/{site}/... (API URL)
    if (segs[0] === 'wday' && segs[1] === 'cxs' && segs[3]) return { host, tenant: segs[2]!, site: segs[3] };
    const rest = segs[0] && LOCALE.test(segs[0]) ? segs.slice(1) : segs;
    if (!rest[0]) throw new Error(`no Workday site in ${url.href}`);
    return { host, tenant, site: rest[0] };
  }
  if (host.endsWith('.myworkdaysite.com')) {
    const rest = segs[0] && LOCALE.test(segs[0]) ? segs.slice(1) : segs;
    // /recruiting/{tenant}/{site}
    if (rest[0] === 'recruiting' && rest[1] && rest[2]) return { host, tenant: rest[1], site: rest[2] };
    if (segs[0] === 'wday' && segs[1] === 'cxs' && segs[3]) return { host, tenant: segs[2]!, site: segs[3] };
  }
  throw new Error(`not a Workday careers URL: ${url.href}`);
}

/** The canonical board_token for a parsed board. */
export function formatWorkdayToken(b: WorkdayBoard): string {
  if (b.host.endsWith('.myworkdayjobs.com')) return `${b.host.replace(/\.myworkdayjobs\.com$/, '')}/${b.site}`;
  return `${b.host}/${b.tenant}/${b.site}`;
}

export function jobsApiUrl(b: WorkdayBoard): string {
  return `https://${b.host}/wday/cxs/${encodeURIComponent(b.tenant)}/${encodeURIComponent(b.site)}/jobs`;
}

/** `externalPath` looks like `/job/Bangalore/Software-Engineer_R-123`. */
export function detailApiUrl(b: WorkdayBoard, externalPath: string): string {
  return `https://${b.host}/wday/cxs/${encodeURIComponent(b.tenant)}/${encodeURIComponent(b.site)}${externalPath}`;
}

export function publicJobUrl(b: WorkdayBoard, externalPath: string): string {
  if (b.host.endsWith('.myworkdaysite.com')) return `https://${b.host}/recruiting/${b.tenant}/${b.site}${externalPath}`;
  return `https://${b.host}/${b.site}${externalPath}`;
}

// ---------------------------------------------------------------------------
// SuccessFactors
// ---------------------------------------------------------------------------

/**
 * SuccessFactors boards come in two flavours:
 *  - classic career sites: `career4.successfactors.com/career?company=acmeP` →
 *    token `career4.successfactors.com/acmeP` (XML job-listing feed);
 *  - Recruiting Marketing (RMK) sites on SAP hosts: `jobs.acme.sapsf.com` →
 *    token `jobs.acme.sapsf.com` (HTML search pages).
 */
export type SuccessFactorsBoard =
  | { kind: 'classic'; host: string; companyId: string }
  | { kind: 'rmk'; host: string };

const SF_CLASSIC = /^career\d*\.successfactors\.(com|eu)$/;
const SF_RMK = /\.(sapsf\.com|sapsf\.eu|successfactors\.eu|successfactors\.com)$/;

export function parseSuccessFactorsToken(raw: string): SuccessFactorsBoard {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) {
    const u = new URL(t);
    const host = u.hostname.toLowerCase();
    if (SF_CLASSIC.test(host)) {
      const company = u.searchParams.get('company');
      if (!company) throw new Error(`no company= parameter in ${t}`);
      return { kind: 'classic', host, companyId: company };
    }
    if (SF_RMK.test(host)) return { kind: 'rmk', host };
    throw new Error(`not a SuccessFactors URL: ${t}`);
  }
  const [host = '', companyId, ...rest] = t.split('/');
  const h = host.toLowerCase();
  if (SF_CLASSIC.test(h) && companyId && !rest.length) return { kind: 'classic', host: h, companyId };
  if (!companyId && SF_RMK.test(h) && !SF_CLASSIC.test(h)) return { kind: 'rmk', host: h };
  throw new Error(`invalid SuccessFactors board token "${raw}" (expected "career4.successfactors.com/<companyId>" or "jobs.<tenant>.sapsf.com")`);
}

export function formatSuccessFactorsToken(b: SuccessFactorsBoard): string {
  return b.kind === 'classic' ? `${b.host}/${b.companyId}` : b.host;
}

// ---------------------------------------------------------------------------
// Taleo
// ---------------------------------------------------------------------------

/** `acme.taleo.net/careersection/ex/jobsearch.ftl` → token `acme/ex` (tenant / career section). */
export interface TaleoBoard {
  host: string;
  tenant: string;
  section: string;
}

export function parseTaleoToken(raw: string): TaleoBoard {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) {
    const u = new URL(t);
    const host = u.hostname.toLowerCase();
    const m = u.pathname.match(/\/careersection\/([^/]+)/);
    if (!host.endsWith('.taleo.net') || !m || m[1] === 'rest') throw new Error(`not a Taleo career section URL: ${t}`);
    return { host, tenant: host.split('.')[0]!, section: decodeURIComponent(m[1]!) };
  }
  const parts = t.split('/');
  if (parts.length === 2 && /^[a-z0-9-]+$/i.test(parts[0]!) && parts[1]) {
    const tenant = parts[0]!.toLowerCase();
    return { host: `${tenant}.taleo.net`, tenant, section: parts[1] };
  }
  throw new Error(`invalid Taleo board token "${raw}" (expected "tenant/section")`);
}

export function formatTaleoToken(b: TaleoBoard): string {
  return `${b.tenant}/${b.section}`;
}
