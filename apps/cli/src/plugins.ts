import { PluginRegistry } from '@jobforge/core';
import type { AppConfig } from '@jobforge/shared';
import greenhouse from '@jobforge/source-greenhouse';
import lever from '@jobforge/source-lever';
import ashby from '@jobforge/source-ashby';
import workday from '@jobforge/source-workday';
import smartrecruiters from '@jobforge/source-smartrecruiters';
import gmailAlerts from '@jobforge/source-gmail-alerts';
import successfactors from '@jobforge/source-successfactors';
import taleo from '@jobforge/source-taleo';
import linkedinEmployees from '@jobforge/enricher-linkedin-employees';
import linkedinActor from '@jobforge/actor-linkedin-referral';
import linkedinTracker from '@jobforge/tracker-linkedin';
import deadlineEnricher from '@jobforge/enricher-deadline';
import matcherDefault from '@jobforge/matcher-default';
import contactsPattern from '@jobforge/enricher-contacts-pattern';
import gmailOutreach from '@jobforge/actor-gmail-outreach';
import gmailTracker from '@jobforge/tracker-gmail';
import tailorResume from '@jobforge/tailor-resume-latex';

/** Plugins installed in this build, configured from config.yaml `plugins.<id>`. */
export function createRegistry(config?: AppConfig): PluginRegistry {
  const registry = new PluginRegistry();
  for (const p of [greenhouse, lever, ashby, workday, smartrecruiters, gmailAlerts, successfactors, taleo, linkedinEmployees, linkedinActor, linkedinTracker, deadlineEnricher, matcherDefault, contactsPattern, gmailOutreach, gmailTracker, tailorResume]) {
    registry.register(p, config?.plugins[p.manifest.id] ?? {});
  }
  return registry;
}
