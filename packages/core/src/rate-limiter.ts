export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export interface RateLimit {
  /** Bucket capacity (burst size). */
  tokens: number;
  /** Time to refill a full bucket. */
  intervalMs: number;
}

/**
 * Continuous-refill token bucket. Callers queue in FIFO order, so a burst of
 * concurrent requests to one domain is spread out rather than racing.
 */
export class TokenBucket {
  private available: number;
  private last: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly limit: RateLimit,
    private readonly clock: Clock = systemClock,
  ) {
    this.available = limit.tokens;
    this.last = clock.now();
  }

  acquire(signal?: AbortSignal): Promise<void> {
    const next = this.tail.then(() => this.take(signal));
    // Keep the chain alive even if one waiter aborts.
    this.tail = next.catch(() => undefined);
    return next;
  }

  private refill(): void {
    const now = this.clock.now();
    const rate = this.limit.tokens / this.limit.intervalMs;
    this.available = Math.min(this.limit.tokens, this.available + (now - this.last) * rate);
    this.last = now;
  }

  private async take(signal?: AbortSignal): Promise<void> {
    this.refill();
    if (this.available < 1) {
      const rate = this.limit.tokens / this.limit.intervalMs;
      await this.clock.sleep(Math.ceil((1 - this.available) / rate), signal);
      this.refill();
    }
    this.available -= 1;
  }
}

/**
 * One bucket per host, shared by every plugin in the process so two plugins
 * hitting the same domain can't double the request rate. The first limit
 * registered for a host wins; later, stricter limits replace it.
 */
export class DomainRateLimiter {
  private buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly defaultLimit: RateLimit = { tokens: 2, intervalMs: 1000 },
    private readonly clock: Clock = systemClock,
  ) {}

  bucketFor(host: string, limit?: RateLimit): TokenBucket {
    const wanted = limit ?? this.defaultLimit;
    const existing = this.buckets.get(host);
    if (existing && rate(existing.limit) <= rate(wanted)) return existing;
    const bucket = new TokenBucket(wanted, this.clock);
    this.buckets.set(host, bucket);
    return bucket;
  }

  acquire(host: string, limit?: RateLimit, signal?: AbortSignal): Promise<void> {
    return this.bucketFor(host, limit).acquire(signal);
  }
}

function rate(l: RateLimit): number {
  return l.tokens / l.intervalMs;
}
