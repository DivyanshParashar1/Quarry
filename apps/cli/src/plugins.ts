import { PluginRegistry } from '@jobforge/core';
import { dirname, join } from 'node:path';
import { findUp, type AppConfig } from '@jobforge/shared';
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
import applyGreenhouse from '@jobforge/actor-apply-greenhouse';
import applyLever from '@jobforge/actor-apply-lever';
import applyAshby from '@jobforge/actor-apply-ashby';
import matcherDefault from '@jobforge/matcher-default';
import contactsPattern from '@jobforge/enricher-contacts-pattern';
import gmailOutreach from '@jobforge/actor-gmail-outreach';
import gmailTracker from '@jobforge/tracker-gmail';
import tailorResume from '@jobforge/tailor-resume-latex';

/** Plugins installed in this build, configured from config.yaml `plugins.<id>`. */
export function createRegistry(config?: AppConfig): PluginRegistry {
  const registry = new PluginRegistry();
  for (const p of [greenhouse, lever, ashby, workday, smartrecruiters, gmailAlerts, successfactors, taleo, linkedinEmployees, linkedinActor, linkedinTracker, deadlineEnricher, applyGreenhouse, applyLever, applyAshby, matcherDefault, contactsPattern, gmailOutreach, gmailTracker, tailorResume]) {
    registry.register(p, { ...pathDefaults(p.manifest.id), ...(config?.plugins[p.manifest.id] ?? {}) });
  }
  return registry;
}

/** Browser actors write screenshots under <repo>/data/screenshots, whatever the cwd. */
function pathDefaults(id: string): Record<string, unknown> {
  const ws = findUp('pnpm-workspace.yaml');
  const root = ws ? dirname(ws) : process.cwd();
  if (id.startsWith('actor-apply-')) return { screenshotDir: join(root, 'data', 'screenshots', 'apply') };
  if (id === 'actor-linkedin-referral') return { screenshotDir: join(root, 'data', 'screenshots', 'linkedin') };
  return {};
}
