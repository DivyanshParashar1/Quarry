import { decodeEntities } from './html.js';

// Dependency-free helpers for XML feeds and messy HTML (SuccessFactors, Taleo).

/** Inner contents of every `<tag ...>…</tag>` (case-insensitive, non-nested). */
export function xmlElements(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => m[1]!);
}

/** Text of the first child element among `names` (CDATA unwrapped, entities decoded). */
export function xmlChild(inner: string, names: string[]): string | null {
  for (const n of names) {
    const [v] = xmlElements(inner, n.replace(/[-]/g, '\\-'));
    if (v !== undefined) {
      const t = v.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
      return t ? (/<!\[CDATA\[/.test(v) ? t : decodeEntities(t)) : null;
    }
  }
  return null;
}

/**
 * Strict cleanup for ATS-authored HTML (inline styles, MS Office markup,
 * fonts): keeps structure (p, br, ul/ol/li, b/strong/i/em, h1-6, a href,
 * table cells), drops every other tag and every attribute except href.
 */
export function sanitizeHtml(html: string): string {
  const KEEP = new Set(['p', 'br', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'table', 'tr', 'td', 'th', 'div']);
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|xml|head|o:p|v:\w+)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?([a-z][a-z0-9:]*)\b([^>]*)>/gi, (m, tag: string, attrs: string) => {
      const t = tag.toLowerCase();
      if (!KEEP.has(t)) return t === 'span' || t === 'font' ? '' : ' ';
      if (m.startsWith('</')) return `</${t}>`;
      if (t === 'a') {
        const href = attrs.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
        return href && /^https?:/i.test(href) ? `<a href="${href}">` : '<a>';
      }
      return `<${t}>`;
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(<p>\s*<\/p>|<div>\s*<\/div>)/g, '')
    .trim();
}
