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
