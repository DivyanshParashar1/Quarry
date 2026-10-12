import { PluginRegistry } from '@quarry/core/fetch';
import type { AppConfig } from '@quarry/shared';
import greenhouse from '@quarry/source-greenhouse';
import lever from '@quarry/source-lever';
import ashby from '@quarry/source-ashby';
import workday from '@quarry/source-workday';
import smartrecruiters from '@quarry/source-smartrecruiters';
import successfactors from '@quarry/source-successfactors';
import taleo from '@quarry/source-taleo';

/**
 * The company-board source plugins only, configured from config.yaml
 * `plugins.<id>` like the laptop's registry. source-gmail-alerts stays on the
 * laptop (it needs the Gmail token).
 */
export function createSourceRegistry(config?: AppConfig): PluginRegistry {
  const registry = new PluginRegistry();
  for (const p of [greenhouse, lever, ashby, workday, smartrecruiters, successfactors, taleo]) {
    registry.register(p, config?.plugins[p.manifest.id] ?? {});
  }
  return registry;
}
