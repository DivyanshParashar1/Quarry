export * from './manifest.js';
export * from './types.js';
export * from './errors.js';
export * from './html.js';

import type { SourcePlugin } from './types.js';

/** Identity helper that pins the plugin's config type for authors. */
export function defineSourcePlugin<C>(plugin: SourcePlugin<C>): SourcePlugin<C> {
  return plugin;
}
