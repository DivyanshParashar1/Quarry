import type { Token } from './html.js';

/** One job found in an alert email. */
export interface AlertPosting {
  externalId: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  remote: 'remote' | 'hybrid' | 'onsite' | null;
}

export interface AlertParser {
  id: string;
  label: string;
  /** Gmail `from:` terms; one search per sender. */
  senders: string[];
  /** Matches a job link; group 1 is the portal's job id. */
  jobUrl: RegExp;
  /** Canonical, tracking-free URL for the job. */
  canonicalUrl(id: string, href: string): string;
  /** Turn the text lines that follow a job title into company/location. Default: `defaultMeta`. */
  meta?(lines: string[], title: string): { company: string | null; location: string | null };
  /** Where company/location text sits relative to the title link (default 'after'). */
  metaPosition?: 'before' | 'after';
  /** Alerts that name the company in the subject ("New jobs at Acme") rather than per card. */
  companyFromSubject?(subject: string): string | null;
  /** Link texts that are buttons, not titles. */
  junkTitles?: RegExp;
  /** Phrases a real alert from this sender contains; a message without any isn't an alert (e.g. a password reset). */
  alertMarker?: RegExp;
}

const JUNK = /^(view( job| details| all| more)?|apply( now)?|easy apply|see (all|more)( jobs)?|save|share|unsubscribe|learn more|view similar jobs|search jobs|manage alerts?|check it out|know more|jobs? (for you|alert)|\d+ new jobs?|logo|image)$/i;

/** Lines that are never a company or a location. */
const NOISE = /(\b\d+\s*(?:-|–|to)\s*\d+\s*(yrs?|years)\b|\b\d+\+?\s*(yrs?|years)\b|\blpa\b|\blacs?\b|₹|\binr\b|\$\d|not disclosed|\bposted\b|\bago\b|actively recruiting|easy apply|promoted|applicants?|alumni|connections?|\bstipend\b|apply by|\bopenings?\b|be an early applicant|reviewed|responds?|^new$|\bsalary\b)/i;

const SEP = /\s+[·•|]\s+|\s+-\s+(?=[A-Z])/;

export function remoteFrom(text: string | null): AlertPosting['remote'] {
  if (!text) return null;
  if (/hybrid/i.test(text)) return 'hybrid';
  if (/remote|work from home|wfh/i.test(text)) return 'remote';
  if (/on-?site|in office/i.test(text)) return 'onsite';
  return null;
}

export function isNoise(line: string): boolean {
  return line.length > 120 || NOISE.test(line) || /^[·•|,\-–]+$/.test(line.trim());
}

/** "Acme · Bengaluru, India (Hybrid) · ₹10L" or ["Acme", "·", "Bengaluru"] → company + location. */
export function defaultMeta(lines: string[]): { company: string | null; location: string | null } {
  const parts: string[] = [];
  for (const line of lines) {
    for (const p of line.split(SEP).map((x) => x.trim())) if (p && !isNoise(p)) parts.push(p);
    if (parts.length >= 2) break;
  }
  return { company: parts[0] ?? null, location: parts[1] ?? null };
}

/**
 * Group the email's job links by job id (an alert links the same job from the
 * logo, the title and a button), take the first real title, and read the text
 * that follows it up to the next job.
 */
export function parseCards(parser: AlertParser, tokens: Token[], subject = ''): AlertPosting[] {
  const junk = parser.junkTitles ?? JUNK;
  const order: string[] = [];
  const cards = new Map<string, { href: string; title: string | null; lines: string[]; open: boolean }>();
  let current: string | null = null;
  const before = parser.metaPosition === 'before';
  /** Text seen since the last job link (the "before" meta of the next job). */
  let pending: string[] = [];

  for (const t of tokens) {
    if (t.type === 'link') {
      const m = t.href.match(parser.jobUrl);
      if (m?.[1]) {
        const id = m[1];
        let card = cards.get(id);
        if (!card) {
          card = { href: t.href, title: null, lines: before ? pending.slice(-6) : [], open: !before };
          cards.set(id, card);
          order.push(id);
        }
        pending = [];
        if (current && current !== id) cards.get(current)!.open = false;
        current = id;
        const text = t.text.trim();
        if (!card.title && text && !junk.test(text) && text.length <= 160) card.title = text;
        continue;
      }
      // Any other link (company page, settings) — its text can still be the company name.
      if (current && t.text && !junk.test(t.text)) cards.get(current)!.lines.push(t.text);
      continue;
    }
    pending.push(t.text);
    if (!current) continue;
    const card = cards.get(current)!;
    if (!card.open) continue;
    if (!card.title) {
      // Some templates put the title in plain text right after an image link.
      if (!junk.test(t.text) && !NOISE.test(t.text) && t.text.length <= 160) card.title = t.text;
      continue;
    }
    if (card.lines.length < 6) card.lines.push(t.text);
  }

  const subjectCompany = parser.companyFromSubject?.(subject) ?? null;
  const out: AlertPosting[] = [];
  for (const id of order) {
    const c = cards.get(id)!;
    if (!c.title) continue;
    const meta = (parser.meta ?? defaultMeta)(c.lines.filter((l) => l !== c.title), c.title);
    const company = meta.company ?? subjectCompany;
    if (!company) continue;
    out.push({
      externalId: `${parser.id}:${id}`,
      title: c.title,
      company: cleanCompany(company),
      location: meta.location ? meta.location.replace(/\s*\((hybrid|remote|on-?site)\)\s*$/i, '').trim() || null : null,
      url: parser.canonicalUrl(id, c.href),
      remote: remoteFrom([meta.location, ...c.lines].join(' ')),
    });
  }
  return out;
}

function cleanCompany(s: string): string {
  return s.replace(/^(at|@)\s+/i, '').replace(/\s*\(.*?\)\s*$/, '').trim();
}
