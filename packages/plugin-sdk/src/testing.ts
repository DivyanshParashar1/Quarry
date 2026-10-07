import { readFileSync } from 'node:fs';
import pino from 'pino';
import { HttpError, DomainNotAllowedError } from './errors.js';
import type { HttpRequestInit, PluginContext, ScopedHttp, SourceTarget } from './types.js';
import { hostAllowed } from './manifest.js';
import type { GmailHandle } from './capabilities.js';

export interface FixtureRoute {
  status?: number;
  /** Path to a fixture file (served verbatim), or an inline body (JSON-encoded unless `text`). */
  file?: string;
  body?: unknown;
  /** Raw text body (HTML, XML). */
  text?: string;
  /** Defaults to application/json, or text/html for `text` / non-.json files. */
  contentType?: string;
  /** Extra response headers (e.g. `location` for a redirect). */
  headers?: Record<string, string>;
}

/** A route can depend on the request (e.g. a POST body carrying a page offset). */
export type FixtureRouteSpec = FixtureRoute | ((init: HttpRequestInit) => FixtureRoute | undefined);

/**
 * A ScopedHttp that serves recorded fixtures by exact URL (or `"POST <url>"` for
 * POSTs). Unknown URLs fail loudly so a test can never fall through to the network.
 */
export function fixtureHttp(routes: Record<string, FixtureRouteSpec>, domains: readonly string[]): ScopedHttp & {
  calls: string[];
  /** Request bodies, in call order (undefined for body-less requests). */
  bodies: (string | undefined)[];
} {
  const calls: string[] = [];
  const bodies: (string | undefined)[] = [];
  const request = async (url: string, init: HttpRequestInit = {}): Promise<Response> => {
    const host = new URL(url).hostname;
    if (!hostAllowed(host, domains)) throw new DomainNotAllowedError(host, 'test');
    calls.push(url);
    bodies.push(init.body);
    const method = init.method ?? 'GET';
    const spec = (method !== 'GET' ? routes[`${method} ${url}`] : undefined) ?? routes[url];
    const route = typeof spec === 'function' ? spec(init) : spec;
    if (!route) throw new Error(`no fixture for ${method} ${url}`);
    let body: string;
    let type = route.contentType;
    if (route.file !== undefined) {
      body = readFileSync(route.file, 'utf8');
      type ??= route.file.endsWith('.json') ? 'application/json' : route.file.endsWith('.xml') ? 'application/xml' : 'text/html';
    } else if (route.text !== undefined) {
      body = route.text;
      type ??= 'text/html';
    } else {
      body = JSON.stringify(route.body ?? null);
    }
    const status = route.status ?? 200;
    return new Response(status === 204 || status === 304 ? null : body, {
      status,
      headers: { 'content-type': type ?? 'application/json', ...route.headers },
    });
  };
  const check = async (url: string, init?: HttpRequestInit): Promise<Response> => {
    const res = await request(url, init);
    if (!res.ok) throw new HttpError(`${init?.method ?? 'GET'} ${url} -> ${res.status}`, url, res.status);
    return res;
  };
  return {
    calls,
    bodies,
    request,
    async getJson<T>(url: string, init?: HttpRequestInit): Promise<T> {
      return (await (await check(url, init)).json()) as T;
    },
    async getText(url: string, init?: HttpRequestInit): Promise<string> {
      return (await check(url, init)).text();
    },
  };
}

export function testContext<C>(
  config: C,
  http: ScopedHttp = fixtureHttp({}, []),
  extra: Partial<Pick<PluginContext<C>, 'llm' | 'embed' | 'gmail' | 'dns' | 'dryRun' | 'emit' | 'browser'>> = {},
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

export function testTarget(boardToken: string, companyName = 'TestCo', options?: Record<string, unknown>): SourceTarget {
  return { companySourceId: 'cs-1', companyId: 'c-1', companyName, boardToken, ...(options ? { options } : {}) };
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
  /** HTML body, for alert-style messages. */
  html?: string;
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
    receive(m: { threadId: string; from: string; subject: string; body?: string; html?: string; headers?: Record<string, string>; at?: Date }): FakeMessage;
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
        ...(r.html !== undefined ? { html: r.html } : {}),
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
            if (t.startsWith('from:')) return (m.headers.from ?? '').toLowerCase().includes(t.slice(5).toLowerCase());
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
    async getMessageBody(id) {
      const m = messages.find((x) => x.id === id);
      if (!m) throw new Error(`no message ${id}`);
      return { html: m.html ?? null, text: m.body || null };
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

// ---------------------------------------------------------------------------
// Scripted fake browser for browser-plugin tests (LinkedIn, ATS apply)
// ---------------------------------------------------------------------------

export interface FakeBrowserAction {
  type: 'goto' | 'click' | 'fill' | 'type' | 'upload' | 'select' | 'check' | 'screenshot' | 'mouse';
  url: string;
  selector?: string;
  value?: string | string[];
}

export interface FakeBrowserOptions {
  /**
   * HTML per URL. A key ending in `*` matches any URL with that prefix
   * (longest prefix wins). Values may be functions of the visit count.
   */
  pages: Record<string, string | ((visit: number) => string)>;
  /** Called on click; return a URL to navigate to, or HTML to replace the current page with. */
  onClick?: (selector: string, page: { url: string; html: string }) => { goto?: string; html?: string } | void;
  /** Selectors that are never visible even if their key appears in the HTML. */
  hidden?: string[];
}

/** The text a selector looks for, for the fake's substring visibility check. */
export function selectorKey(selector: string): string {
  const s = selector.trim();
  let m = s.match(/^text=["']?(.+?)["']?$/);
  if (m) return m[1]!;
  m = s.match(/:has-text\(["'](.+?)["']\)/);
  if (m) return m[1]!;
  m = s.match(/\[([a-z-]+)\s*[*^$]?=\s*["']([^"']+)["']\]/i);
  if (m) return `${m[1]}="${m[2]}`;
  m = s.match(/^#([\w-]+)/);
  if (m) return `id="${m[1]}"`;
  return s;
}

export function fakeBrowser(opts: FakeBrowserOptions) {
  const actions: FakeBrowserAction[] = [];
  const visits = new Map<string, number>();
  const resolve = (url: string): string => {
    let html: string | ((n: number) => string) | undefined = opts.pages[url];
    if (html === undefined) {
      const prefix = Object.keys(opts.pages)
        .filter((k) => k.endsWith('*') && url.startsWith(k.slice(0, -1)))
        .sort((a, b) => b.length - a.length)[0];
      if (prefix) html = opts.pages[prefix];
    }
    if (html === undefined) throw new Error(`fakeBrowser: no page for ${url}`);
    const n = (visits.get(url) ?? 0) + 1;
    visits.set(url, n);
    return typeof html === 'function' ? html(n) : html;
  };

  const newPage = async () => {
    const state = { url: 'about:blank', html: '' };
    const visible = (sel: string) => !opts.hidden?.includes(sel) && state.html.includes(selectorKey(sel));
    const need = (sel: string) => {
      if (!visible(sel)) throw new Error(`fakeBrowser: selector not found: ${sel} on ${state.url}`);
    };
    const page = {
      async goto(url: string) {
        actions.push({ type: 'goto', url });
        state.html = resolve(url);
        state.url = url;
        return null;
      },
      url: () => state.url,
      content: async () => state.html,
      title: async () => state.html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '',
      async click(selector: string) {
        need(selector);
        actions.push({ type: 'click', url: state.url, selector });
        const r = opts.onClick?.(selector, { ...state });
        if (r?.goto) await page.goto(r.goto);
        else if (r?.html !== undefined) state.html = r.html;
      },
      async fill(selector: string, value: string) {
        need(selector);
        actions.push({ type: 'fill', url: state.url, selector, value });
      },
      async pressSequentially(selector: string, value: string) {
        need(selector);
        actions.push({ type: 'type', url: state.url, selector, value });
      },
      async setInputFiles(selector: string, files: string | string[]) {
        need(selector);
        actions.push({ type: 'upload', url: state.url, selector, value: files });
      },
      async selectOption(selector: string, values: string | string[]) {
        need(selector);
        actions.push({ type: 'select', url: state.url, selector, value: values });
        return Array.isArray(values) ? values : [values];
      },
      async check(selector: string) {
        need(selector);
        actions.push({ type: 'check', url: state.url, selector });
      },
      isVisible: async (selector: string) => visible(selector),
      async waitForSelector(selector: string, o: { state?: string } = {}) {
        const want = o.state === 'hidden' || o.state === 'detached' ? false : true;
        if (visible(selector) !== want) throw new Error(`fakeBrowser: timeout waiting for ${selector} (${o.state ?? 'visible'})`);
        return null;
      },
      waitForTimeout: async () => {},
      async screenshot(o: { path?: string } = {}) {
        actions.push({ type: 'screenshot', url: state.url, ...(o.path ? { value: o.path } : {}) });
        const buf = Buffer.from(`fake screenshot of ${state.url}`);
        if (o.path) await (await import('node:fs/promises')).writeFile(o.path, buf);
        return buf;
      },
      mouse: {
        move: async () => {
          actions.push({ type: 'mouse', url: state.url });
        },
        wheel: async () => {},
      },
      close: async () => {},
    };
    return page;
  };
  return { kind: 'browser' as const, newPage, actions };
}
