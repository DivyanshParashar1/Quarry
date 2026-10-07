// robots.txt support for careers-page scraping (CLAUDE.md: respect robots.txt).
// Implements the parts of RFC 9309 that matter here: user-agent groups,
// Allow/Disallow with longest-match precedence, `*` and `$` wildcards.

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

/** Parse robots.txt and return the rules that apply to `userAgent` (falls back to `*`). */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' && value) current.allow.push(value);
    else if (key === 'disallow' && value) current.disallow.push(value);
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
  };
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Longest matching rule wins; Allow wins a tie. No matching rule = allowed. */
export function isPathAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
  let best = -1;
  let allowed = true;
  for (const [list, verdict] of [
    [rules.disallow, false],
    [rules.allow, true],
  ] as const) {
    for (const p of list) {
      if (!patternToRegex(p).test(pathAndQuery)) continue;
      if (p.length > best || (p.length === best && verdict)) {
        best = p.length;
        allowed = verdict;
      }
    }
  }
  return allowed;
}

export type RobotsFetch = (url: string) => Promise<{ status: number; body: string }>;

export type RobotsVerdict = 'allowed' | 'disallowed' | 'unreachable';

/**
 * Per-origin cache. 4xx = no restrictions; 5xx = treat the site as disallowed
 * (RFC 9309 §2.3.1.3); a network failure = unreachable (also not fetched).
 */
export class RobotsCache {
  private cache = new Map<string, Promise<RobotsRules | 'all-disallowed' | 'unreachable'>>();

  constructor(
    private readonly fetchRobots: RobotsFetch,
    private readonly userAgent = 'JobForge',
  ) {}

  async allowed(url: string): Promise<boolean> {
    return (await this.verdict(url)) === 'allowed';
  }

  async verdict(url: string): Promise<RobotsVerdict> {
    const u = new URL(url);
    let entry = this.cache.get(u.origin);
    if (!entry) {
      entry = this.load(u.origin);
      this.cache.set(u.origin, entry);
    }
    const rules = await entry;
    if (rules === 'all-disallowed') return 'disallowed';
    if (rules === 'unreachable') return 'unreachable';
    return isPathAllowed(rules, u.pathname + u.search) ? 'allowed' : 'disallowed';
  }

  private async load(origin: string): Promise<RobotsRules | 'all-disallowed' | 'unreachable'> {
    try {
      const r = await this.fetchRobots(`${origin}/robots.txt`);
      if (r.status >= 500) return 'all-disallowed';
      if (r.status >= 400) return { allow: [], disallow: [] };
      return parseRobots(r.body, this.userAgent);
    } catch {
      return 'unreachable';
    }
  }
}
