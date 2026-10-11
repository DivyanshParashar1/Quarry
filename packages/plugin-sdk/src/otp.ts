import { decodeEntities } from './html.js';
import type { GmailHandle } from './capabilities.js';

// Phase 19: one-time codes and magic links an ATS emails during an application
// (Greenhouse's security code, SmartRecruiters / Workday email verification).
// The actor polls the user's Gmail (read scope) for mail from the ATS's
// domains that arrived after the step started, and extracts the code. No
// match within the timeout → OtpTimeoutError (the core raises an attention item).

export class OtpTimeoutError extends Error {
  constructor(
    readonly fromDomains: string[],
    readonly waitedMs: number,
  ) {
    super(`no verification email from ${fromDomains.join(', ')} within ${Math.round(waitedMs / 1000)} s`);
  }
}

export interface OtpResult {
  code: string | null;
  link: string | null;
  messageId: string;
  receivedAt: Date;
}

export interface OtpWaitOptions {
  /** Sender domains to accept (e.g. greenhouse-mail.io, smartrecruiters.com). */
  fromDomains: string[];
  /** Only mail received at/after this moment counts (the step that triggered it). */
  since: Date;
  timeoutMs?: number;
  pollMs?: number;
  /** Prefer a magic link over a code (account-verification emails). */
  want?: 'code' | 'link' | 'either';
  /** Test hooks. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// Per-ATS phrasings first, then generic ones. Codes are 4–10 characters; at least one digit
// unless the ATS uses letters (Greenhouse's 8-character security code).
const CODE_PATTERNS: RegExp[] = [
  /security code[\s\S]{0,160}?\b([A-Za-z0-9]{8})\b/i, // Greenhouse: the 8-character code, usually on its own line
  /verification code(?: is)?[^A-Za-z0-9]{0,40}?\b(\d{4,8})\b/i, // Workday, SmartRecruiters
  /\b(?:one[- ]time (?:pass(?:word|code)|code)|otp|passcode)\b[^A-Za-z0-9]{0,40}?\b(\d{4,8})\b/i,
  /\b(?:your|the|enter(?: the)?|use(?: the)?)\s+(?:\w+\s+){0,3}code(?: is|:)?[^A-Za-z0-9]{0,20}?\b([A-Z0-9]{4,10})\b/i,
  /\bcode[:\s]+\b(\d{4,8})\b/i,
];

const LINK_RE = /https:\/\/[^\s"'<>]+?(?:verify|verification|confirm|activate|activation|magic|token|login|signin|sign-in)[^\s"'<>]*/gi;

/** A plausible code: has a digit (and isn't a bare year) — or, for Greenhouse's letter codes, mixed case. */
function plausible(c: string, lettersOk: boolean): boolean {
  if (/^(19|20)\d{2}$/.test(c)) return false;
  if (/\d/.test(c)) return true;
  return lettersOk && (c.match(/[a-z]/g) ?? []).length >= 2 && (c.match(/[A-Z]/g) ?? []).length >= 2;
}

/** Text of an email (plain part, else the HTML stripped). */
export function emailText(body: { text: string | null; html: string | null }): string {
  if (body.text?.trim()) return body.text;
  return decodeEntities((body.html ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/td>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** The code (and/or a verification link) in an email, or nulls. */
export function extractOtp(body: { text: string | null; html: string | null }): { code: string | null; link: string | null } {
  const text = emailText(body);
  let code: string | null = null;
  for (const [i, re] of CODE_PATTERNS.entries()) {
    const c = text.match(re)?.[1];
    if (c && plausible(c, i === 0)) {
      code = c;
      break;
    }
  }
  const links = [...(body.html ?? '').matchAll(/href="([^"]+)"/gi)].map((m) => decodeEntities(m[1]!)).concat([...text.matchAll(LINK_RE)].map((m) => m[0]));
  const link = links.find((l) => /^https:\/\//i.test(l) && /verify|verification|confirm|activate|magic|token/i.test(l) && !/unsubscribe|privacy|help/i.test(l)) ?? null;
  return { code, link };
}

/** Gmail query for mail from one domain after `since` (Gmail's after: takes epoch seconds; a minute of slack). */
export function otpQuery(fromDomain: string, since: Date): string {
  return `from:${fromDomain} after:${Math.floor(since.getTime() / 1000) - 60}`;
}

/** Poll Gmail until a verification email with a code/link arrives, or time out. */
export async function waitForOtp(gmail: GmailHandle, o: OtpWaitOptions): Promise<OtpResult> {
  if (!gmail.search || !gmail.getMessage || !gmail.getMessageBody) throw new Error('reading verification emails needs the gmail read permission');
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  const timeout = o.timeoutMs ?? 5 * 60_000;
  const start = now();
  const seen = new Set<string>();
  const want = o.want ?? 'either';
  for (;;) {
    const refs = (await Promise.all(o.fromDomains.map((d) => gmail.search!(otpQuery(d, o.since), 10)))).flat();
    for (const ref of refs) {
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      const meta = await gmail.getMessage(ref.id);
      if (meta.internalDate.getTime() < o.since.getTime() - 5_000) continue;
      const sender = (meta.headers.from ?? '').toLowerCase();
      if (!o.fromDomains.some((d) => sender.includes(d.toLowerCase()))) continue;
      const { code, link } = extractOtp(await gmail.getMessageBody(ref.id));
      if ((want === 'code' && code) || (want === 'link' && link) || (want === 'either' && (code || link))) {
        return { code, link, messageId: ref.id, receivedAt: meta.internalDate };
      }
    }
    if (now() - start >= timeout) throw new OtpTimeoutError(o.fromDomains, now() - start);
    await sleep(o.pollMs ?? 10_000);
  }
}
