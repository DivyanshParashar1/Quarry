import { describe, it, expect, vi } from 'vitest';
import { DomainNotAllowedError, HttpError } from '@jobforge/plugin-sdk';
import { createScopedHttp, retryAfterMs } from './http.js';
import { DomainRateLimiter, TokenBucket } from './rate-limiter.js';
import { fakeClock, jsonResponse, silentLogger } from './test-utils.js';

function setup(fetchImpl: typeof fetch, retries = 3) {
  const clock = fakeClock();
  const http = createScopedHttp({
    pluginId: 'source-test',
    domains: ['api.example.com', 'cdn.example.com'],
    limiter: new DomainRateLimiter({ tokens: 100, intervalMs: 1000 }, clock),
    log: silentLogger,
    signal: new AbortController().signal,
    fetch: fetchImpl,
    clock,
    retries,
    baseDelayMs: 100,
  });
  return { http, clock };
}

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then spaces requests by the refill rate', async () => {
    const clock = fakeClock();
    const b = new TokenBucket({ tokens: 2, intervalMs: 1000 }, clock);
    await Promise.all([b.acquire(), b.acquire(), b.acquire(), b.acquire()]);
    // 2 immediate, then one token every 500ms
    expect(clock.sleeps).toEqual([500, 500]);
    expect(clock.t).toBe(1000);
  });

  it('refills over elapsed time', async () => {
    const clock = fakeClock();
    const b = new TokenBucket({ tokens: 1, intervalMs: 1000 }, clock);
    await b.acquire();
    clock.t += 1000;
    await b.acquire();
    expect(clock.sleeps).toEqual([]);
  });
});

describe('DomainRateLimiter', () => {
  it('shares one bucket per host and keeps the stricter limit', () => {
    const l = new DomainRateLimiter({ tokens: 10, intervalMs: 1000 }, fakeClock());
    const a = l.bucketFor('h.com');
    expect(l.bucketFor('h.com')).toBe(a);
    const strict = l.bucketFor('h.com', { tokens: 1, intervalMs: 1000 });
    expect(strict).not.toBe(a);
    expect(l.bucketFor('h.com', { tokens: 50, intervalMs: 1000 })).toBe(strict);
  });
});

describe('ScopedHttp', () => {
  it('rejects hosts outside the allowlist without making a request', async () => {
    const f = vi.fn();
    const { http } = setup(f as unknown as typeof fetch);
    await expect(http.getJson('https://evil.com/x')).rejects.toBeInstanceOf(DomainNotAllowedError);
    await expect(http.getJson('http://api.example.com/x')).rejects.toBeInstanceOf(DomainNotAllowedError);
    expect(f).not.toHaveBeenCalled();
  });

  it('returns parsed JSON and sends a user agent', async () => {
    const f = vi.fn(async (_u: URL, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['user-agent']).toMatch(/JobForge/);
      return jsonResponse({ ok: 1 });
    });
    const { http } = setup(f as unknown as typeof fetch);
    expect(await http.getJson('https://api.example.com/x')).toEqual({ ok: 1 });
  });

  it('retries 5xx with exponential backoff then succeeds', async () => {
    const responses = [jsonResponse({}, 503), jsonResponse({}, 502), jsonResponse({ ok: 1 })];
    const f = vi.fn(async () => responses.shift()!);
    const { http, clock } = setup(f as unknown as typeof fetch);
    expect(await http.getJson('https://api.example.com/x')).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(3);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(clock.sleeps[1]).toBeGreaterThanOrEqual(200);
  });

  it('honours Retry-After on 429', async () => {
    const responses = [jsonResponse({}, 429, { 'retry-after': '7' }), jsonResponse({ ok: 1 })];
    const { http, clock } = setup((async () => responses.shift()!) as unknown as typeof fetch);
    await http.getJson('https://api.example.com/x');
    expect(clock.sleeps).toEqual([7000]);
  });

  it('does not retry a 404 and throws a permanent HttpError', async () => {
    const f = vi.fn(async () => jsonResponse({ error: 'nope' }, 404));
    const { http } = setup(f as unknown as typeof fetch);
    const err = await http.getJson('https://api.example.com/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).permanent).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget on network errors', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { http } = setup(f as unknown as typeof fetch, 2);
    const err = await http.getJson('https://api.example.com/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).permanent).toBe(false);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('follows redirects only within the allowlist', async () => {
    const ok = vi.fn(async (u: URL) =>
      u.hostname === 'api.example.com'
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/y' } })
        : jsonResponse({ hop: u.hostname }),
    );
    expect(await setup(ok as unknown as typeof fetch).http.getJson('https://api.example.com/x')).toEqual({
      hop: 'cdn.example.com',
    });

    const bad = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'https://evil.com/' } }));
    await expect(setup(bad as unknown as typeof fetch).http.getJson('https://api.example.com/x')).rejects.toBeInstanceOf(
      DomainNotAllowedError,
    );
  });
});

describe('retryAfterMs', () => {
  it('parses seconds and HTTP dates, and caps', () => {
    expect(retryAfterMs('3', 0)).toBe(3000);
    expect(retryAfterMs('9999', 0)).toBe(60_000);
    expect(retryAfterMs(new Date(5000).toUTCString(), 0)).toBe(5000);
    expect(retryAfterMs('garbage', 0)).toBeNull();
    expect(retryAfterMs(null, 0)).toBeNull();
  });
});
