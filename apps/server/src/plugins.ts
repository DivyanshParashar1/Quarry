import { PluginRegistry } from '@jobforge/core';
import type { AppConfig } from '@jobforge/shared';
import greenhouse from '@jobforge/source-greenhouse';
import lever from '@jobforge/source-lever';
import ashby from '@jobforge/source-ashby';
import contactsPattern from '@jobforge/enricher-contacts-pattern';
import gmailOutreach from '@jobforge/actor-gmail-outreach';
import gmailTracker from '@jobforge/tracker-gmail';
import tailorResume from '@jobforge/tailor-resume-typst';

/** Plugins the server runs, configured from config.yaml `plugins.<id>`. */
export function createRegistry(config?: AppConfig): PluginRegistry {
  const registry = new PluginRegistry();
  for (const p of [greenhouse, lever, ashby, contactsPattern, gmailOutreach, gmailTracker, tailorResume]) {
    registry.register(p, config?.plugins[p.manifest.id] ?? {});
  }
  return registry;
}
