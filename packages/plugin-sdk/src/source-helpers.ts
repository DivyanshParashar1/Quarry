// Small helpers shared by source plugins.

const DAY = 24 * 3600_000;

/**
 * Parse relative "posted" strings that ATSs show instead of dates:
 * "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago",
 * "2 weeks ago", "1 month ago". Returns null when the text isn't recognised.
 */
export function parseRelativePosted(text: string | null | undefined, now: Date = new Date()): Date | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(today|just now|just posted|hours? ago|minutes? ago)\b/.test(t)) return startOfDay(now);
  if (/\byesterday\b/.test(t)) return startOfDay(new Date(now.getTime() - DAY));
  const m = t.match(/(\d+)\+?\s*(day|week|month)s?\s+ago/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] === 'day' ? DAY : m[2] === 'week' ? 7 * DAY : 30 * DAY;
  return startOfDay(new Date(now.getTime() - n * unit));
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Case-insensitive substring filter used by sources with a `locations` option.
 * An empty filter accepts everything; an empty location list is accepted too
 * (we can't tell, so we keep the posting rather than miss it).
 */
export function matchesLocationFilter(locations: readonly string[], filters: readonly string[]): boolean {
  if (!filters.length || !locations.length) return true;
  const hay = locations.map((l) => l.toLowerCase());
  return filters.some((f) => hay.some((l) => l.includes(f.toLowerCase())));
}

/** Infer a remote policy from free text such as "Remote", "Hybrid - Bengaluru", "On-site". */
export function remotePolicyFromText(text: string | null | undefined): 'remote' | 'hybrid' | 'onsite' | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes('hybrid')) return 'hybrid';
  if (/\bremote\b|work from home|wfh/.test(t)) return 'remote';
  if (/on-?site|in[- ]office|office based/.test(t)) return 'onsite';
  return null;
}
