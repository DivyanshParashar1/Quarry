export * from './manifest.js';
export * from './types.js';
export * from './errors.js';
export * from './html.js';
export * from './capabilities.js';
export * from './outreach.js';
export * from './tailor.js';
export * from './source-helpers.js';
export * from './ats-tokens.js';
export * from './markup.js';

import type { ActorPlugin, EnricherPlugin, MatcherPlugin, SourcePlugin, TailorPlugin, TrackerPlugin } from './types.js';

/** Identity helper that pins the plugin's config type for authors. */
export function defineSourcePlugin<C>(plugin: SourcePlugin<C>): SourcePlugin<C> {
  return plugin;
}

export function defineMatcherPlugin<C>(plugin: MatcherPlugin<C>): MatcherPlugin<C> {
  return plugin;
}

export function defineEnricherPlugin<C, E>(plugin: EnricherPlugin<C, E>): EnricherPlugin<C, E> {
  return plugin;
}

export function defineActorPlugin<C, I, D, R>(plugin: ActorPlugin<C, I, D, R>): ActorPlugin<C, I, D, R> {
  return plugin;
}

export function defineTailorPlugin<C>(plugin: TailorPlugin<C>): TailorPlugin<C> {
  return plugin;
}

export function defineTrackerPlugin<C>(plugin: TrackerPlugin<C>): TrackerPlugin<C> {
  return plugin;
}
