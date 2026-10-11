import type { LLMClient, LLMRequest, LLMResponse } from '@jobforge/shared';
import { getState, setState, type DB } from '@jobforge/db';
import type { LoadedPlugin } from './plugins.js';

// Phase 22: runtime switches the orchestrator (or you) can flip without a
// restart, kept in app_state:
//   ops.pausedPlugins   — a plugin that keeps failing is skipped until `until`
//   ops.llmPausedUntil  — the day's LLM budget is spent: LLM steps wait
//   apply.tenantOverrides — per-tenant selector/step overrides for the apply actors

const PAUSED = 'ops.pausedPlugins';
const LLM_PAUSED = 'ops.llmPausedUntil';
const TENANTS = 'apply.tenantOverrides';

export interface PluginPause {
  until: string | null;
  reason: string;
  at: string;
}

export async function pausedPlugins(db: DB, now = new Date()): Promise<Record<string, PluginPause>> {
  const all = (await getState<Record<string, PluginPause>>(db, PAUSED)) ?? {};
  return Object.fromEntries(Object.entries(all).filter(([, p]) => !p.until || new Date(p.until) > now));
}

export async function isPluginPaused(db: DB, pluginId: string, now = new Date()): Promise<boolean> {
  return pluginId in (await pausedPlugins(db, now));
}

/** Pause (until a time, or indefinitely with null) or resume (pause = null) a plugin. */
export async function setPluginPause(db: DB, pluginId: string, pause: { until: Date | null; reason: string } | null, now = new Date()): Promise<void> {
  const all = { ...(await pausedPlugins(db, now)) };
  if (pause) all[pluginId] = { until: pause.until?.toISOString() ?? null, reason: pause.reason, at: now.toISOString() };
  else delete all[pluginId];
  await setState(db, PAUSED, all);
}

export async function llmPausedUntil(db: DB, now = new Date()): Promise<Date | null> {
  const v = await getState<{ until: string }>(db, LLM_PAUSED);
  return v && new Date(v.until) > now ? new Date(v.until) : null;
}

export async function setLlmPausedUntil(db: DB, until: Date | null): Promise<void> {
  await setState(db, LLM_PAUSED, until ? { until: until.toISOString() } : { until: new Date(0).toISOString() });
}

export class LlmPausedError extends Error {
  constructor(readonly until: Date) {
    super(`LLM steps are paused until ${until.toISOString()} (daily LLM budget reached)`);
    this.name = 'LlmPausedError';
  }
}

/** An LLM client that refuses calls while the budget pause is on (checked per call). */
export function budgetGuardedLlm(llm: LLMClient, db: DB, now: () => Date = () => new Date()): LLMClient {
  return {
    async generate<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
      const until = await llmPausedUntil(db, now());
      if (until) throw new LlmPausedError(until);
      return llm.generate(req);
    },
  };
}

export type TenantOverrides = Record<string, Record<string, Record<string, unknown>>>;

export async function tenantOverrides(db: DB): Promise<TenantOverrides> {
  return (await getState<TenantOverrides>(db, TENANTS)) ?? {};
}

/** Set (or with null clear) one tenant's override for an apply actor. Validated by the caller against the plugin's schema. */
export async function setTenantOverride(db: DB, pluginId: string, tenant: string, override: Record<string, unknown> | null): Promise<void> {
  const all = await tenantOverrides(db);
  const forPlugin = { ...(all[pluginId] ?? {}) };
  if (override) forPlugin[tenant] = override;
  else delete forPlugin[tenant];
  await setState(db, TENANTS, { ...all, [pluginId]: forPlugin });
}

/**
 * The plugin with the stored tenant overrides merged into its `tenants` config
 * (stored ones win). Re-validated by the plugin's own schema; an override that
 * doesn't validate is ignored (the error is returned for logging).
 */
export function withTenantOverrides(loaded: LoadedPlugin, overrides: Record<string, Record<string, unknown>> | undefined): { loaded: LoadedPlugin; error?: string } {
  if (!overrides || !Object.keys(overrides).length) return { loaded };
  const cfg = (loaded.config ?? {}) as { tenants?: Record<string, unknown> };
  if (!('tenants' in cfg)) return { loaded };
  const merged = { ...cfg, tenants: { ...(cfg.tenants ?? {}), ...overrides } };
  const parsed = loaded.manifest.configSchema.safeParse(merged);
  if (!parsed.success) return { loaded, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { loaded: { ...loaded, config: parsed.data } };
}
