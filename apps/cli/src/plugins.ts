import { PluginRegistry } from '@jobforge/core';
import type { AppConfig } from '@jobforge/shared';
import greenhouse from '@jobforge/source-greenhouse';
import lever from '@jobforge/source-lever';
import matcherDefault from '@jobforge/matcher-default';

/** Plugins installed in this build, configured from config.yaml `plugins.<id>`. */
export function createRegistry(config?: AppConfig): PluginRegistry {
  const registry = new PluginRegistry();
  for (const p of [greenhouse, lever, matcherDefault]) {
    registry.register(p, config?.plugins[p.manifest.id] ?? {});
  }
  return registry;
}
