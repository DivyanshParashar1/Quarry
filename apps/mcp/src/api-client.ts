// Thin client for the JobForge HTTP API (apps/server). The MCP server never
// touches the database directly: everything goes through the same API and
// guards the dashboard uses.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const b = body as { message?: string; error?: string; issues?: string[] } | null;
    super(b?.message ?? b?.issues?.join('; ') ?? b?.error ?? `HTTP ${status}`);
  }
}

export interface ApiClient {
  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  send<T = unknown>(method: 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<T>;
}

export function createApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch): ApiClient {
  const base = baseUrl.replace(/\/$/, '');
  const handle = async <T>(res: Response): Promise<T> => {
    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  };
  return {
    async get(path, query = {}) {
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '') as [string, string][]);
      const res = await fetchImpl(`${base}${path}${qs.size ? `?${qs}` : ''}`, { headers: { accept: 'application/json' } }).catch((err: Error) => {
        throw new Error(`JobForge server not reachable at ${base} (start it with \`pnpm server\`): ${err.message}`);
      });
      return handle(res);
    },
    async send(method, path, body = {}) {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-jobforge': '1' },
        body: JSON.stringify(body),
      }).catch((err: Error) => {
        throw new Error(`JobForge server not reachable at ${base}: ${err.message}`);
      });
      return handle(res);
    },
  };
}
