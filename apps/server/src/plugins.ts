import { PluginRegistry } from '@jobforge/core';
import greenhouse from '@jobforge/source-greenhouse';
import lever from '@jobforge/source-lever';

/** Plugins installed in this build. Per-plugin config arrives with config.yaml in a later phase. */
export function createRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(greenhouse);
  registry.register(lever);
  return registry;
}
