import type { Logger } from '@jobforge/shared';
import { DomainNotAllowedError, HttpError, type HttpRequestInit, type ScopedHttp } from '@jobforge/plugin-sdk';
import { systemClock, type Clock, type DomainRateLimiter, type RateLimit } from './rate-limiter.js';

export const USER_AGENT = 'JobForge/0.1 (self-hosted personal job search)';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_REDIRECTS = 5;
const MAX_RETRY_AFTER_MS = 60_000;

export interface ScopedHttpOptions {
  pluginId: string;
  domains: readonly string[];
  rateLimit?: RateLimit | undefined;
  limiter: DomainRateLimiter;
  log: Logger;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
  /** Retries after the first attempt. */
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
}

/**
 * The only network path a plugin gets. Enforces the manifest's domain
 * allowlist (including on every redirect hop), the per-domain token bucket,
 * timeouts, and retry-with-backoff on transient failures.
 */
export function createScopedHttp(opts: ScopedHttpOptions): ScopedHttp {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const clock = opts.clock ?? systemClock;
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const allowed = new Set(opts.domains);

  function checkHost(url: URL): void {
    if (url.protocol !== 'https:') {
      throw new DomainNotAllowedError(`${url.protocol}//${url.host}`, opts.pluginId);
    }
    if (!allowed.has(url.hostname)) throw new DomainNotAllowedError(url.hostname, opts.pluginId);
  }

  async function once(url: URL, init: HttpRequestInit): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      checkHost(current);
      await opts.limiter.acquire(current.hostname, opts.rateLimit, opts.signal);
      const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(init.timeoutMs ?? opts.timeoutMs ?? 30_000)]);
      const res = await doFetch(current, {
        method: init.method ?? 'GET',
        headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: 'manual',
        signal,
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current);
        continue;
      }
      return res;
    }
    throw new HttpError(`too many redirects from ${url.href}`, url.href, null);
  }

  async function request(rawUrl: string, init: HttpRequestInit = {}): Promise<Response> {
    const url = new URL(rawUrl);
    checkHost(url);
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= retries;
      let res: Response;
      try {
        res = await once(url, init);
      } catch (err) {
        if (err instanceof DomainNotAllowedError || opts.signal.aborted) throw err;
        if (err instanceof HttpError) throw err;
        if (last) throw new HttpError(`request to ${url.href} failed: ${(err as Error).message}`, url.href, null);
        const delay = backoff(attempt, baseDelayMs);
        opts.log.debug({ url: url.href, attempt, delay, err: (err as Error).message }, 'http network error, retrying');
        await clock.sleep(delay, opts.signal);
        continue;
      }
      if (!RETRYABLE_STATUS.has(res.status) || last) {
        opts.log.debug({ url: url.href, status: res.status, attempt }, 'http response');
        return res;
      }
      const delay = retryAfterMs(res.headers.get('retry-after'), clock.now()) ?? backoff(attempt, baseDelayMs);
      opts.log.debug({ url: url.href, status: res.status, attempt, delay }, 'http retryable status, retrying');
      await res.body?.cancel();
      await clock.sleep(delay, opts.signal);
    }
  }

  return {
    request,
    async getJson<T>(rawUrl: string, init?: HttpRequestInit): Promise<T> {
      const res = await request(rawUrl, init);
      if (!res.ok) {
        await res.body?.cancel();
        throw new HttpError(`GET ${rawUrl} -> ${res.status}`, rawUrl, res.status);
      }
      try {
        return (await res.json()) as T;
      } catch (err) {
        throw new HttpError(`invalid JSON from ${rawUrl}: ${(err as Error).message}`, rawUrl, res.status);
      }
    },
  };
}

function backoff(attempt: number, baseMs: number): number {
  const exp = baseMs * 2 ** attempt;
  return Math.round(exp + Math.random() * exp * 0.25);
}

export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}
