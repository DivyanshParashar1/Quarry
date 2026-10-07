import type { AlertParser } from '../cards.js';

/** YC Work at a Startup digest. Cards: "Company (W21)" then the role link. */
export const yc: AlertParser = {
  id: 'yc',
  label: 'YC Work at a Startup',
  senders: ['workatastartup.com', 'ycombinator.com'],
  jobUrl: /workatastartup\.com\/jobs\/(\d+)/i,
  canonicalUrl: (id) => `https://www.workatastartup.com/jobs/${id}`,
  metaPosition: 'before',
  meta(lines) {
    // "Acme (S23) · Bengaluru, India / Remote"
    const first = [...lines].reverse().find((l) => /\([WSFX]\d{2}\)/.test(l) || l.includes('·')) ?? lines.at(-1);
    if (!first) return { company: null, location: null };
    const [company, ...rest] = first.split(/\s+[·•|]\s+/);
    return { company: company ?? null, location: rest.join(', ') || null };
  },
  alertMarker: /work at a startup|startup jobs|yc companies|jobs?/i,
};
