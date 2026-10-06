import { readFileSync } from 'node:fs';
import pino from 'pino';
import { HttpError, DomainNotAllowedError } from './errors.js';
import type { PluginContext, ScopedHttp, SourceTarget } from './types.js';

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
  extra: Pick<PluginContext<C>, 'llm' | 'embed'> = {},
): PluginContext<C> {
  return {
    config,
    http,
    ...extra,
    log: pino({ level: 'silent' }),
    signal: new AbortController().signal,
    dryRun: true,
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
