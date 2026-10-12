# Writing a plugin

Every stage of the pipeline is a plugin under `plugins/<id>/`. A plugin is a package that exports a manifest
and the stage's methods. It depends **only** on `@quarry/plugin-sdk` and `@quarry/shared` — never on
`@quarry/core` or `@quarry/db` — and touches the outside world only through the context the core gives it.

## Layout

```
plugins/source-acme/
  package.json        # name @quarry/source-acme; workspace:* deps on plugin-sdk + shared
  tsconfig.json       # extends ../../tsconfig.base.json
  fixtures/           # recorded real responses
  src/
    index.ts          # export default define<Stage>Plugin({ manifest, ...stage methods })
    index.test.ts
```

Register it in `packages/plugins/src/index.ts` (the one list the CLI and server share), then `pnpm i`.

Ids are kebab-case and start with the stage: `source-`, `enricher-`, `matcher-`, `tailor-`, `actor-`, `tracker-`.

## Manifest

```ts
import { z } from 'zod';
import { defineSourcePlugin } from '@quarry/plugin-sdk';

const configSchema = z.object({ pageSize: z.number().int().default(100) }).strict();
type AcmeConfig = z.infer<typeof configSchema>;

export default defineSourcePlugin<AcmeConfig>({
  manifest: {
    id: 'source-acme',
    version: '0.1.0',
    stage: 'source',
    description: 'Acme ATS public job board',
    configSchema,                       // validated from config.yaml plugins.source-acme before running
    permissions: {
      domains: ['api.acme-ats.com'],    // exact hosts or *.suffix; anything else is rejected
      // llm: true, browser: true, dns: true, gmail: ['read'], credentials: true
    },
    rateLimit: { perDomain: { tokens: 2, intervalMs: 1000 } },
    sideEffects: 'none',                // actors must declare 'external'
  },

  async *fetch(ctx, target) {
    const body = await ctx.http.getJson(`https://api.acme-ats.com/boards/${target.boardToken}/jobs`);
    // validate with zod, then yield one RawPosting per job
  },
});
```

There is a `define*Plugin` helper per stage: `defineSourcePlugin`, `defineEnricherPlugin`,
`defineMatcherPlugin`, `defineTailorPlugin`, `defineActorPlugin`, `defineTrackerPlugin`.

## Context

The core injects a `PluginContext`; plugins never build one.

| Field | Present when | Notes |
|---|---|---|
| `config` | always | parsed by `configSchema` |
| `http` | always | `fetch` wrapper: domain allowlist, per-domain token bucket, retries with backoff |
| `llm` | `permissions.llm` | structured, zod-validated generation; logged to `llm_calls` |
| `embed` | when available | local embeddings |
| `browser` | `permissions.browser` | Playwright handle |
| `gmail` | `permissions.gmail` | scoped to `read` / `send` |
| `dns` | `permissions.dns` | MX lookups only |
| `credentials` | `permissions.credentials` | per-account passwords in the OS keychain |
| `log` | always | pino logger — never `console.log` |
| `signal` | always | aborted on timeout or shutdown |
| `dryRun` | always | true unless the run is live |

Never call `fetch()` directly; always `ctx.http`.

## Stage contracts

```ts
interface SourcePlugin<C>   { fetch(ctx, target: SourceTarget): AsyncIterable<RawPosting> }
interface EnricherPlugin<C> { enrich(ctx, job: Job, company: Company): Promise<Enrichment> }
interface MatcherPlugin<C>  { score(ctx, jobs: Job[], profile: Profile): Promise<MatchResult[]> }
interface TailorPlugin<C>   { tailor(ctx, job: Job, profile: Profile): Promise<TailoredArtifacts> }
interface ActorPlugin<C> {
  prepare(ctx, input: ActionInput): Promise<ActionDraft>;                                   // no side effects
  execute(ctx, draft: ApprovedDraft, idempotencyKey: string): Promise<ActionResult>;
}
interface TrackerPlugin<C>  { poll(ctx, since: Date): AsyncIterable<TrackEvent> }
```

### Actor rules

- `prepare()` must have no side effects; its draft becomes a review item.
- `execute()` only receives an `ApprovedDraft`, which only the core can mint from an approved review item.
- Branch on `ctx.dryRun`: log what you would do and return a synthetic result.
- The idempotency key is unique in `actions`; make `execute()` safe to retry (e.g. check whether it already
  happened before acting).
- Account-based form flows should reuse `plugin-sdk/wizard.ts` (accounts, consent, OTP, unknown-page handling).

## Testing

- External HTTP is tested against **recorded fixtures** in `fixtures/`, never live endpoints. Fetch one real
  response by hand, inspect it, save it.
- At minimum: the manifest validates, the config schema accepts a good example, and the stage method produces
  the right output from the fixture.
- `pnpm --filter @quarry/<id> typecheck && pnpm --filter @quarry/<id> test`

In Claude Code, the project's `new-plugin` skill scaffolds all of this.
