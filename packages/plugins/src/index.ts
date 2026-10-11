import { PluginRegistry } from '@quarry/core';
import { dirname, isAbsolute, join } from 'node:path';
import { findUp, type AppConfig } from '@quarry/shared';
import greenhouse from '@quarry/source-greenhouse';
import lever from '@quarry/source-lever';
import ashby from '@quarry/source-ashby';
import workday from '@quarry/source-workday';
import smartrecruiters from '@quarry/source-smartrecruiters';
import gmailAlerts from '@quarry/source-gmail-alerts';
import successfactors from '@quarry/source-successfactors';
import taleo from '@quarry/source-taleo';
import linkedinEmployees from '@quarry/enricher-linkedin-employees';
import linkedinActor from '@quarry/actor-linkedin-referral';
import linkedinTracker from '@quarry/tracker-linkedin';
import deadlineEnricher from '@quarry/enricher-deadline';
import applyGreenhouse from '@quarry/actor-apply-greenhouse';
import applyLever from '@quarry/actor-apply-lever';
import applyAshby from '@quarry/actor-apply-ashby';
import applySmartRecruiters from '@quarry/actor-apply-smartrecruiters';
import applyWorkday from '@quarry/actor-apply-workday';
import applySuccessFactors from '@quarry/actor-apply-successfactors';
import applyTaleo from '@quarry/actor-apply-taleo';
import matcherDefault from '@quarry/matcher-default';
import contactsPattern from '@quarry/enricher-contacts-pattern';
import gmailOutreach from '@quarry/actor-gmail-outreach';
import gmailTracker from '@quarry/tracker-gmail';
import tailorResume from '@quarry/tailor-resume-latex';
import linkedinManual from '@quarry/actor-linkedin-manual';

/** Every installed plugin (the one list the CLI and the server share), configured from config.yaml `plugins.<id>`. */
export function createRegistry(config?: AppConfig): PluginRegistry {
  const registry = new PluginRegistry();
  for (const p of [greenhouse, lever, ashby, workday, smartrecruiters, gmailAlerts, successfactors, taleo, linkedinEmployees, linkedinActor, linkedinTracker, deadlineEnricher, applyGreenhouse, applyLever, applyAshby, applySmartRecruiters, applyWorkday, applySuccessFactors, applyTaleo, matcherDefault, contactsPattern, gmailOutreach, gmailTracker, tailorResume, linkedinManual]) {
    registry.register(p, { ...pathDefaults(p.manifest.id), ...rootRelative(config?.plugins[p.manifest.id] ?? {}) });
  }
  return registry;
}

function repoRoot(): string {
  const ws = findUp('pnpm-workspace.yaml');
  return ws ? dirname(ws) : process.cwd();
}

/** Path options a plugin reads from disk; relative values in config.yaml mean "from the repo root". */
const PATH_KEYS = ['manifestPath', 'screenshotDir'];

function rootRelative(cfg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...cfg };
  for (const k of PATH_KEYS) {
    const v = out[k];
    if (typeof v === 'string' && !isAbsolute(v)) out[k] = join(repoRoot(), v);
  }
  return out;
}

/**
 * Plugin paths are anchored at the repo root, whatever the cwd (the server runs
 * from apps/server): browser screenshots under data/screenshots, the resume
 * manifest under profile/resume.
 */
function pathDefaults(id: string): Record<string, unknown> {
  const root = repoRoot();
  if (id === 'tailor-resume-latex') return { manifestPath: join(root, 'profile', 'resume', 'manifest.yaml') };
  if (id.startsWith('actor-apply-')) return { screenshotDir: join(root, 'data', 'screenshots', 'apply') };
  if (id === 'actor-linkedin-referral') return { screenshotDir: join(root, 'data', 'screenshots', 'linkedin') };
  return {};
}
