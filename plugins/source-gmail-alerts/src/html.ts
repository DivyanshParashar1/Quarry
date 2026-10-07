import { decodeEntities } from '@jobforge/plugin-sdk';

export type Token = { type: 'text'; text: string } | { type: 'link'; href: string; text: string };

const BLOCK = /^(p|div|br|tr|td|th|li|ul|ol|table|tbody|h[1-6]|section|article|header|footer|span)$/i;

/**
 * Flatten an HTML email into text runs and links, in document order. Text is
 * split at block-ish boundaries (and on `<span>`, because alert templates put
 * company and location in sibling spans). Links keep their own text.
 */
export function tokenize(html: string): Token[] {
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, ' ');
  const out: Token[] = [];
  let buf = '';
  const flush = () => {
    const t = norm(buf);
    if (t) out.push({ type: 'text', text: t });
    buf = '';
  };
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>|<\/?([a-z0-9]+)\b[^>]*>|([^<]+)/gi;
  for (const m of clean.matchAll(re)) {
    if (m[1] !== undefined) {
      flush();
      const href = m[1].match(/href\s*=\s*["']([^"']*)["']/i)?.[1];
      // Inner text of the link, split on block tags so "Title<br>Company" yields the title.
      const inner = (m[2] ?? '').split(/<(?:br|\/?(?:p|div|tr|td|span|table))\b[^>]*>/i).map((x) => norm(x.replace(/<[^>]+>/g, ' '))).filter(Boolean);
      if (href) out.push({ type: 'link', href: decodeEntities(href.trim()), text: inner[0] ?? '' });
      for (const extra of inner.slice(1)) out.push({ type: 'text', text: extra });
    } else if (m[3] !== undefined) {
      if (BLOCK.test(m[3])) flush();
    } else if (m[4] !== undefined) {
      buf += m[4];
    }
  }
  flush();
  return out;
}

function norm(s: string): string {
  return decodeEntities(s).replace(/[\u00a0\s]+/g, ' ').trim();
}

/** Text tokens only (for plain-text bodies and simple lookups). */
export function textLines(tokens: Token[]): string[] {
  return tokens.filter((t): t is Extract<Token, { type: 'text' }> => t.type === 'text').map((t) => t.text);
}

/** Tokenize a plain-text email: each non-empty line is a text token, bare URLs become links. */
export function tokenizeText(text: string): Token[] {
  const out: Token[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const url = line.match(/https?:\/\/\S+/);
    if (url) {
      const before = line.slice(0, url.index).replace(/[:\-–|]+\s*$/, '').trim();
      out.push({ type: 'link', href: url[0].replace(/[>)\].,]+$/, ''), text: before });
    } else out.push({ type: 'text', text: line });
  }
  return out;
}
