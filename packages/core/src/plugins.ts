import { PluginError, type Embedder, type LLMClient, type Logger } from '@jobforge/shared';
import {
  pluginManifestSchema,
  stageMethods,
  type ActorPlugin,
  type AnyPlugin,
  type DnsResolver,
  type EnricherPlugin,
  type GmailHandle,
  type MatcherPlugin,
  type TrackerPlugin,
  type PluginContext,
  type PluginManifest,
  type SourcePlugin,
  type Stage,
  type TailorPlugin,
} from '@jobforge/plugin-sdk';
import { createScopedHttp } from './http.js';
import { scopeGmail } from './capabilities.js';
import type { Clock, DomainRateLimiter } from './rate-limiter.js';

export interface LoadedPlugin<P extends AnyPlugin = AnyPlugin> {
  plugin: P;
  manifest: PluginManifest;
  config: unknown;
}

/**
 * Validate a plugin module: manifest shape, the stage's required methods, and
 * the supplied config against the plugin's own configSchema. Accepts either the
 * plugin object or a module namespace with a `default` export.
 */
export function loadPlugin(mod: unknown, rawConfig: unknown = {}): LoadedPlugin {
  const candidate = (isObject(mod) && 'default' in mod ? mod.default : mod) as Partial<AnyPlugin> | undefined;
  if (!isObject(candidate)) throw new PluginError('plugin module does not export a plugin object');

  const parsed = pluginManifestSchema.safeParse(candidate.manifest);
  if (!parsed.success) {
    const id = isObject(candidate.manifest) ? String(candidate.manifest.id) : '<unknown>';
    throw new PluginError(`invalid manifest for ${id}: ${formatIssues(parsed.error.issues)}`);
  }
  const manifest = parsed.data;

  for (const method of stageMethods[manifest.stage]) {
    if (typeof (candidate as Record<string, unknown>)[method] !== 'function') {
      throw new PluginError(`${manifest.id}: stage "${manifest.stage}" requires a ${method}() method`);
    }
  }

  const config = manifest.configSchema.safeParse(rawConfig ?? {});
  if (!config.success) {
    throw new PluginError(`invalid config for ${manifest.id}: ${formatIssues(config.error.issues)}`);
  }

  return { plugin: candidate as AnyPlugin, manifest, config: config.data };
}

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();

  register(mod: unknown, rawConfig?: unknown): LoadedPlugin {
    const loaded = loadPlugin(mod, rawConfig);
    if (this.plugins.has(loaded.manifest.id)) {
      throw new PluginError(`duplicate plugin id ${loaded.manifest.id}`);
    }
    this.plugins.set(loaded.manifest.id, loaded);
    return loaded;
  }

  get(id: string): LoadedPlugin {
    const p = this.plugins.get(id);
    if (!p) throw new PluginError(`unknown plugin ${id}`);
    return p;
  }

  byStage(stage: Stage): LoadedPlugin[] {
    return [...this.plugins.values()].filter((p) => p.manifest.stage === stage);
  }

  source(id: string): LoadedPlugin<SourcePlugin> {
    const p = this.get(id);
    if (p.manifest.stage !== 'source') throw new PluginError(`${id} is not a source plugin`);
    return p as LoadedPlugin<SourcePlugin>;
  }

  enricher(id: string): LoadedPlugin<EnricherPlugin> {
    return this.ofStage<EnricherPlugin>(id, 'enricher');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actor(id: string): LoadedPlugin<ActorPlugin<any, any, any, any>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.ofStage<ActorPlugin<any, any, any, any>>(id, 'actor');
  }

  tracker(id: string): LoadedPlugin<TrackerPlugin> {
    return this.ofStage<TrackerPlugin>(id, 'tracker');
  }

  private ofStage<P extends AnyPlugin>(id: string, stage: Stage): LoadedPlugin<P> {
    const p = this.get(id);
    if (p.manifest.stage !== stage) throw new PluginError(`${id} is not a ${stage} plugin`);
    return p as LoadedPlugin<P>;
  }

  matcher(id: string): LoadedPlugin<MatcherPlugin> {
    const p = this.get(id);
    if (p.manifest.stage !== 'matcher') throw new PluginError(`${id} is not a matcher plugin`);
    return p as LoadedPlugin<MatcherPlugin>;
  }

  tailor(id: string): LoadedPlugin<TailorPlugin> {
    return this.ofStage<TailorPlugin>(id, 'tailor');
  }

  list(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }
}

export interface ContextDeps {
  limiter: DomainRateLimiter;
  log: Logger;
  signal: AbortSignal;
  dryRun: boolean;
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
  httpRetries?: number;
  /** Handed only to plugins whose manifest declares permissions.llm. */
  llm?: LLMClient;
  embed?: Embedder;
  /** Handed only to plugins declaring permissions.dns. */
  dns?: DnsResolver;
  /** Full client; narrowed to the manifest's gmail scopes before a plugin sees it. */
  gmail?: GmailHandle;
  /** Receives ctx.emit() calls; the runner persists them as events. */
  onEvent?: (kind: string, data: Record<string, unknown>) => void;
}

/** Build the capability-scoped context a plugin runs with. Nothing else from the core leaks in. */
export function buildContext<C>(loaded: LoadedPlugin, deps: ContextDeps): PluginContext<C> {
  const log = deps.log.child({ plugin: loaded.manifest.id });
  const wantsLlm = loaded.manifest.permissions.llm === true;
  if (wantsLlm && !deps.llm) throw new PluginError(`${loaded.manifest.id} needs an LLM client but none is configured`);
  const wantsDns = loaded.manifest.permissions.dns === true;
  if (wantsDns && !deps.dns) throw new PluginError(`${loaded.manifest.id} needs DNS but no resolver was provided`);
  const gmail = scopeGmail(deps.gmail, loaded.manifest);
  return {
    ...(wantsDns && deps.dns ? { dns: deps.dns } : {}),
    ...(gmail ? { gmail } : {}),
    ...(wantsLlm && deps.llm ? { llm: deps.llm } : {}),
    ...(deps.embed ? { embed: deps.embed } : {}),
    config: loaded.config as C,
    http: createScopedHttp({
      pluginId: loaded.manifest.id,
      domains: loaded.manifest.permissions.domains,
      rateLimit: loaded.manifest.rateLimit?.perDomain,
      limiter: deps.limiter,
      log,
      signal: deps.signal,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.httpRetries !== undefined ? { retries: deps.httpRetries } : {}),
    }),
    log,
    signal: deps.signal,
    dryRun: deps.dryRun,
    ...(deps.onEvent ? { emit: (kind: string, data: Record<string, unknown>) => deps.onEvent!(`plugin.${loaded.manifest.id}.${kind}`, data) } : {}),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function formatIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}
