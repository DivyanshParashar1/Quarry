import { createHash } from 'node:crypto';

// Plain-text RFC 5322 message builder. Header values are stripped of CR/LF so
// a draft can never inject headers.

export interface MimeInput {
  from: { name: string; address: string };
  to: { name: string; address: string };
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  date?: Date;
}

const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/** RFC 2047 encoded-word when needed. */
export function encodeHeader(s: string): string {
  const v = clean(s);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

export function formatAddress(a: { name: string; address: string }): string {
  const addr = clean(a.address);
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(addr)) throw new Error(`invalid email address: ${addr}`);
  const name = clean(a.name);
  if (!name) return addr;
  const enc = encodeHeader(name);
  return `${enc === name ? `"${name.replace(/["\\]/g, '')}"` : enc} <${addr}>`;
}

export function buildMime(m: MimeInput): string {
  const headers = [
    `From: ${formatAddress(m.from)}`,
    `To: ${formatAddress(m.to)}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${clean(m.messageId)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${clean(m.inReplyTo)}`] : []),
    ...(m.references?.length ? [`References: ${m.references.map(clean).join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(m.body.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{76}/g, '$&\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

export function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** Deterministic Message-ID for an idempotency key: a retry produces the same ID, so it can be found in Sent. */
export function messageIdFor(idempotencyKey: string, fromAddress: string): string {
  const domain = fromAddress.split('@')[1] ?? 'jobforge.local';
  return `<jobforge.${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}@${domain}>`;
}
