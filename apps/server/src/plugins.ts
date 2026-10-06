import { PluginRegistry } from '@jobforge/core';
import type { AppConfig } from '@jobforge/shared';
import greenhouse from '@jobforge/source-greenhouse';
import lever from '@jobforge/source-lever';
import ashby from '@jobforge/source-ashby';

/** Plugins the worker host runs, configured from config.yaml `plugins.<id>`. */
export function createRegistry(config?: AppConfig): PluginRegistry {
  const registry = new PluginRegistry();
  for (const p of [greenhouse, lever, ashby]) registry.register(p, config?.plugins[p.manifest.id] ?? {});
  return registry;
}
