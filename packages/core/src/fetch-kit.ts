// The slice of the core the phone fetcher (apps/fetcher) runs: plugin host,
// scoped HTTP, rate limiter and normalizer. Nothing here imports the db,
// pg-boss or a browser, so it installs and runs under Termux.
export { buildContext, loadPlugin, PluginRegistry, type ContextDeps, type LoadedPlugin } from './plugins.js';
export { createScopedHttp, USER_AGENT } from './http.js';
export { DomainRateLimiter, systemClock, type Clock, type RateLimit } from './rate-limiter.js';
export { normalizePosting, type NormalizedJob } from './normalize.js';
