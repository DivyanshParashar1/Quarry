import { auth, gmail as gmailApi } from '@googleapis/gmail';
import type { GmailHandle } from '@jobforge/plugin-sdk';
import type { DomainRateLimiter } from './rate-limiter.js';

// The user's own Gmail via OAuth (PLAN.md §2). Only the core holds the
// credentials; plugins get a scoped GmailHandle (see scopeGmail).

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const GMAIL_HOST = 'gmail.googleapis.com';

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function gmailAuthUrl(c: GmailCredentials, state: string): string {
  const client = new auth.OAuth2(c.clientId, c.clientSecret, c.redirectUri);
  // offline + consent so Google returns a refresh token every time.
  return client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: GMAIL_SCOPES, state });
}

export async function exchangeGmailCode(c: GmailCredentials, code: string): Promise<{ refreshToken: string }> {
  const client = new auth.OAuth2(c.clientId, c.clientSecret, c.redirectUri);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google returned no refresh token; revoke the app at myaccount.google.com/permissions and retry');
  return { refreshToken: tokens.refresh_token };
}

/** A rate-limited Gmail client for the authenticated account (all methods). */
export async function createGmailClient(
  c: GmailCredentials & { refreshToken: string },
  limiter: DomainRateLimiter,
): Promise<GmailHandle> {
  const oauth = new auth.OAuth2(c.clientId, c.clientSecret, c.redirectUri);
  oauth.setCredentials({ refresh_token: c.refreshToken });
  const api = gmailApi({ version: 'v1', auth: oauth });
  // Gmail allows far more, but we never need more than a few calls per second.
  const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
    await limiter.acquire(GMAIL_HOST, { tokens: 5, intervalMs: 1000 });
    return fn();
  };
  const profile = await limited(() => api.users.getProfile({ userId: 'me' }));
  const address = profile.data.emailAddress;
  if (!address) throw new Error('Gmail profile has no email address');

  return {
    address,
    async send(raw, threadId) {
      const res = await limited(() =>
        api.users.messages.send({ userId: 'me', requestBody: { raw, ...(threadId ? { threadId } : {}) } }),
      );
      return { id: res.data.id!, threadId: res.data.threadId! };
    },
    async search(q, max = 100) {
      const res = await limited(() => api.users.messages.list({ userId: 'me', q, maxResults: Math.min(max, 500) }));
      return (res.data.messages ?? []).map((m) => ({ id: m.id!, threadId: m.threadId! }));
    },
    async getMessage(id) {
      const res = await limited(() =>
        api.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Message-ID', 'In-Reply-To', 'References', 'X-Failed-Recipients', 'Auto-Submitted', 'Content-Type'],
        }),
      );
      const headers: Record<string, string> = {};
      for (const h of res.data.payload?.headers ?? []) {
        if (h.name && h.value !== undefined && h.value !== null) headers[h.name.toLowerCase()] ??= h.value;
      }
      return {
        id: res.data.id!,
        threadId: res.data.threadId!,
        labelIds: res.data.labelIds ?? [],
        internalDate: new Date(Number(res.data.internalDate ?? 0)),
        snippet: res.data.snippet ?? '',
        headers,
      };
    },
    async getMessageBody(id) {
      const res = await limited(() => api.users.messages.get({ userId: 'me', id, format: 'full' }));
      return extractBodies(res.data.payload ?? undefined);
    },
  };
}

interface GmailPart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
}

/** First text/html and text/plain bodies in a (possibly nested multipart) Gmail payload. */
export function extractBodies(payload: GmailPart | undefined): { html: string | null; text: string | null } {
  let html: string | null = null;
  let text: string | null = null;
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    const data = p.body?.data;
    if (data) {
      const decoded = Buffer.from(data, 'base64url').toString('utf8');
      if (p.mimeType === 'text/html' && html === null) html = decoded;
      else if (p.mimeType === 'text/plain' && text === null) text = decoded;
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return { html, text };
}
