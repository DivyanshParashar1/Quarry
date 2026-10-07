import { HttpError } from '@jobforge/plugin-sdk';
import { USER_AGENT } from '../http.js';
import type { DomainRateLimiter, RateLimit } from '../rate-limiter.js';
import { RobotsCache } from './robots.js';

export interface PageResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  /** Every URL visited, in order (the request URL first). */
  chain: string[];
  body: string;
  contentType: string;
}

/**
 * Fetches arbitrary careers pages for discovery. Unlike a plugin's ScopedHttp
 * it has no host allowlist (the whole point is visiting unknown company
 * sites), but it still rate-limits per host, honours robots.txt on every hop,
 * only speaks https, and caps body size.
 */
export interface PageFetcher {
  get(url: string, init?: { accept?: string; maxBytes?: number }): Promise<PageResponse>;
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`);
  }
}

export interface PageFetcherOptions {
  limiter: DomainRateLimiter;
  /** Default: 1 request per 2s per host — polite for company sites. */
  rateLimit?: RateLimit;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  /** Set false only in tests that don't care about robots. */
  respectRobots?: boolean;
}

const MAX_REDIRECTS = 6;

export function createPageFetcher(opts: PageFetcherOptions): PageFetcher {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const rateLimit = opts.rateLimit ?? { tokens: 1, intervalMs: 2000 };
  const maxBytes = opts.maxBytes ?? 3_000_000;
  const signal = opts.signal ?? new AbortController().signal;

  async function raw(url: URL, accept: string): Promise<Response> {
    await opts.limiter.acquire(url.hostname, rateLimit, signal);
    return doFetch(url, {
      headers: { 'user-agent': USER_AGENT, accept },
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? 20_000)]),
    });
  }

  async function readCapped(res: Response, cap = maxBytes): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const robots = new RobotsCache(async (u) => {
    const res = await raw(new URL(u), 'text/plain');
    return { status: res.status, body: res.ok ? await readCapped(res) : (await res.body?.cancel(), '') };
  });

  return {
    async get(rawUrl, init = {}) {
      const accept = init.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';
      let current = new URL(rawUrl);
      const chain: string[] = [];
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (current.protocol === 'http:') current.protocol = 'https:';
        if (current.protocol !== 'https:') throw new HttpError(`refusing non-https URL ${current.href}`, current.href, null);
        chain.push(current.href);
        if (opts.respectRobots !== false) {
          const v = await robots.verdict(current.href);
          if (v === 'disallowed') throw new RobotsDisallowedError(current.href);
          if (v === 'unreachable') throw new HttpError(`${current.origin} is unreachable`, current.href, null);
        }
        let res: Response;
        try {
          res = await raw(current, accept);
        } catch (err) {
          throw new HttpError(`request to ${current.href} failed: ${(err as Error).message}`, current.href, null);
        }
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel();
          current = new URL(location, current);
          continue;
        }
        return {
          status: res.status,
          url: current.href,
          chain,
          body: await readCapped(res, init.maxBytes),
          contentType: res.headers.get('content-type') ?? '',
        };
      }
      throw new HttpError(`too many redirects from ${rawUrl}`, rawUrl, null);
    },
  };
}
