import pino from 'pino';
import type { Clock } from './rate-limiter.js';

/** A clock whose sleep advances virtual time instantly and records each wait. */
export function fakeClock(start = 0): Clock & { sleeps: number[]; t: number } {
  const c = {
    t: start,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.sleeps.push(ms);
      c.t += ms;
    },
  };
  return c;
}

export const silentLogger = pino({ level: 'silent' });

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
