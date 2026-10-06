import { readFileSync } from 'node:fs';
import pino from 'pino';
import { HttpError, DomainNotAllowedError } from './errors.js';
import type { PluginContext, ScopedHttp, SourceTarget } from './types.js';
import type { GmailHandle } from './capabilities.js';

export interface FixtureRoute {
  status?: number;
  /** Path to a JSON fixture file, or an inline body. */
  file?: string;
  body?: unknown;
}

/**
 * A ScopedHttp that serves recorded fixtures by exact URL. Unknown URLs fail
 * loudly so a test can never fall through to the network.
 */
export function fixtureHttp(routes: Record<string, FixtureRoute>, domains: readonly string[]): ScopedHttp & {
  calls: string[];
} {
  const calls: string[] = [];
  const request = async (url: string): Promise<Response> => {
    const host = new URL(url).hostname;
    if (!domains.includes(host)) throw new DomainNotAllowedError(host, 'test');
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`no fixture for ${url}`);
    const body = route.file !== undefined ? readFileSync(route.file, 'utf8') : JSON.stringify(route.body ?? null);
    return new Response(body, { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    calls,
    request,
    async getJson<T>(url: string): Promise<T> {
      const res = await request(url);
      if (!res.ok) throw new HttpError(`GET ${url} -> ${res.status}`, url, res.status);
      return (await res.json()) as T;
    },
  };
}

export function testContext<C>(
  config: C,
  http: ScopedHttp = fixtureHttp({}, []),
  extra: Partial<Pick<PluginContext<C>, 'llm' | 'embed' | 'gmail' | 'dns' | 'dryRun'>> = {},
): PluginContext<C> {
  return {
    config,
    http,
    log: pino({ level: 'silent' }),
    signal: new AbortController().signal,
    ...extra,
    dryRun: extra.dryRun ?? true,
  };
}

export function testTarget(boardToken: string, companyName = 'TestCo'): SourceTarget {
  return { companySourceId: 'cs-1', companyId: 'c-1', companyName, boardToken };
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// ---------------------------------------------------------------------------
// In-memory Gmail for actor/tracker tests
// ---------------------------------------------------------------------------

export interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: Date;
  raw: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A mailbox implementing the full GmailHandle. Supports the search terms the
 * plugins use: rfc822msgid:, in:sent, in:inbox, after:<epoch seconds>, -from:me.
 */
export function fakeGmail(address = 'me@example.com') {
  const messages: FakeMessage[] = [];
  let seq = 0;
  const now = { t: new Date('2026-10-01T09:00:00Z').getTime() };

  const add = (m: Omit<FakeMessage, 'id' | 'internalDate'> & { internalDate?: Date }): FakeMessage => {
    const msg = { id: `m${++seq}`, internalDate: m.internalDate ?? new Date((now.t += 60_000)), ...m };
    messages.push(msg);
    return msg;
  };

  const handle: GmailHandle & {
    messages: FakeMessage[];
    sent: () => FakeMessage[];
    /** Simulate someone writing into a thread (a reply or a bounce). */
    receive(m: { threadId: string; from: string; subject: string; body?: string; headers?: Record<string, string>; at?: Date }): FakeMessage;
    failNextSend?: Error | undefined;
  } = {
    address,
    messages,
    sent: () => messages.filter((m) => m.labelIds.includes('SENT')),
    async send(raw, threadId) {
      if (handle.failNextSend) {
        const e = handle.failNextSend;
        handle.failNextSend = undefined;
        throw e;
      }
      const text = Buffer.from(raw, 'base64url').toString('utf8');
      const { headers, body } = parseRfc822(text);
      const m = add({ threadId: threadId ?? `t${seq + 1}`, labelIds: ['SENT'], raw, headers, body });
      return { id: m.id, threadId: m.threadId };
    },
    receive(r) {
      const headers = { from: r.from, subject: r.subject, ...(r.headers ?? {}) };
      return add({
        threadId: r.threadId,
        labelIds: ['INBOX'],
        raw: '',
        headers,
        body: r.body ?? '',
        ...(r.at ? { internalDate: r.at } : {}),
      });
    },
    async search(q, max = 100) {
      const terms = q.split(/\s+/).filter(Boolean);
      return messages
        .filter((m) =>
          terms.every((t) => {
            if (t.startsWith('rfc822msgid:')) return (m.headers['message-id'] ?? '') === t.slice(12);
            if (t === 'in:sent') return m.labelIds.includes('SENT');
            if (t === 'in:inbox') return m.labelIds.includes('INBOX');
            if (t.startsWith('after:')) return m.internalDate.getTime() / 1000 > Number(t.slice(6));
            if (t === '-from:me') return !m.labelIds.includes('SENT');
            throw new Error(`fakeGmail: unsupported search term ${t}`);
          }),
        )
        .slice(0, max)
        .map((m) => ({ id: m.id, threadId: m.threadId }));
    },
    async getMessage(id) {
      const m = messages.find((x) => x.id === id);
      if (!m) throw new Error(`no message ${id}`);
      return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, snippet: m.body.slice(0, 120), headers: m.headers };
    },
  };
  return handle;
}

/** Minimal RFC 5322 parse: unfolded, lower-cased headers and the (decoded, if base64) body. */
export function parseRfc822(text: string): { headers: Record<string, string>; body: string } {
  const [head = '', ...rest] = text.split(/\r?\n\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] ??= line.slice(i + 1).trim();
  }
  let body = rest.join('\n\n');
  if ((headers['content-transfer-encoding'] ?? '').toLowerCase() === 'base64') {
    body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  return { headers, body };
}
