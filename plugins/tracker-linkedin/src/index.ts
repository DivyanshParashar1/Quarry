import { z } from 'zod';
import {
  assertNotBlocked,
  canonicalProfileUrl,
  decodeEntities,
  defineTrackerPlugin,
  LINKEDIN_HOST,
  parseRelativePosted,
  type BrowserPage,
  type TrackEvent,
} from '@jobforge/plugin-sdk';

export const configSchema = z
  .object({
    /** Read the connections list (accepted requests). */
    connections: z.boolean().default(true),
    /** Read the messaging inbox (replies). */
    messages: z.boolean().default(true),
  })
  .strict();
export type LinkedInTrackerConfig = z.infer<typeof configSchema>;

export const CONNECTIONS_URL = `https://${LINKEDIN_HOST}/mynetwork/invite-connect/connections/`;
export const MESSAGING_URL = `https://${LINKEDIN_HOST}/messaging/`;

const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export interface AcceptedConnection {
  profileUrl: string;
  name: string;
  connectedAt: Date | null;
}

/** Cards on the connections page, newest first: profile link, name, "Connected 2 days ago". */
export function parseConnections(html: string, now = new Date()): AcceptedConnection[] {
  const out: AcceptedConnection[] = [];
  for (const card of html.split(/<li\b[^>]*class="[^"]*mn-connection-card/i).slice(1)) {
    const href = card.match(/href="([^"]*\/in\/[^"]+)"/i)?.[1];
    const url = href ? canonicalProfileUrl(href.startsWith('/') ? `https://${LINKEDIN_HOST}${href}` : href) : null;
    if (!url) continue;
    const name = strip(card.match(/mn-connection-card__name[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');
    const time = strip(card.match(/<time[^>]*>([\s\S]*?)<\/time>/i)?.[1] ?? '');
    out.push({ profileUrl: url, name, connectedAt: parseRelativePosted(time, now) });
  }
  return out;
}

export interface InboxThread {
  name: string;
  threadUrl: string | null;
  snippet: string;
  /** False when the last message is ours ("You: …"). */
  fromThem: boolean;
  unread: boolean;
}

export function parseInbox(html: string): InboxThread[] {
  const out: InboxThread[] = [];
  for (const item of html.split(/<li\b[^>]*class="[^"]*msg-conversation-listitem/i).slice(1)) {
    const name = strip(item.match(/participant-names[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '');
    if (!name) continue;
    const snippet = strip(item.match(/message-snippet[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '');
    const href = item.match(/href="(\/messaging\/thread\/[^"]+)"/i)?.[1];
    out.push({
      name,
      threadUrl: href ? `https://${LINKEDIN_HOST}${href}` : null,
      snippet,
      fromThem: !/^you:/i.test(snippet),
      unread: /msg-conversation-card__convo-item--unread|unread/i.test(item.slice(0, 400)),
    });
  }
  return out;
}

async function visit(page: BrowserPage, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(1500 + Math.random() * 1500);
  const html = await page.content();
  assertNotBlocked(page.url(), html, await page.title());
  return html;
}

/**
 * Read-only: accepted connection requests and inbox threads whose last
 * message is from the other person. The core keeps only events that match
 * LinkedIn referral threads it opened.
 */
export default defineTrackerPlugin<LinkedInTrackerConfig>({
  manifest: {
    id: 'tracker-linkedin',
    version: '0.1.0',
    stage: 'tracker',
    description: 'Watches your LinkedIn network and inbox for accepted referral requests and replies (read-only).',
    configSchema,
    permissions: { domains: [LINKEDIN_HOST], browser: true },
    rateLimit: { perDomain: { tokens: 1, intervalMs: 15_000 } },
    sideEffects: 'none',
  },

  async *poll(ctx, since) {
    const page = await ctx.browser!.newPage();
    const now = new Date();
    try {
      if (ctx.config.connections) {
        for (const c of parseConnections(await visit(page, CONNECTIONS_URL), now)) {
          // "Connected 2 days ago" is day-granular; keep a day of slack against the cursor.
          if (c.connectedAt && c.connectedAt.getTime() < since.getTime() - 86_400_000) continue;
          const e: TrackEvent = { kind: 'accepted', at: c.connectedAt ?? now, data: { profileUrl: c.profileUrl, name: c.name } };
          yield e;
        }
      }
      if (ctx.config.messages) {
        for (const t of parseInbox(await visit(page, MESSAGING_URL))) {
          if (!t.fromThem) continue;
          const e: TrackEvent = { kind: 'reply', at: now, data: { name: t.name, threadUrl: t.threadUrl, snippet: t.snippet.slice(0, 280) } };
          yield e;
        }
      }
    } finally {
      await page.close();
    }
  },
});
