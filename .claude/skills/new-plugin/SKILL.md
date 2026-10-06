---
name: new-plugin
description: Scaffold a new JobForge plugin (source, enricher, matcher, tailor, actor, or tracker) that conforms to the plugin contract in PLAN.md §4. Use when the user asks to add a plugin, e.g. "add a Workday source", "new matcher plugin", "scaffold actor-X".
---

# new-plugin

Creates a plugin package under `plugins/<id>/` wired to the workspace, with a valid manifest, config schema, stub stage implementation, and a vitest file.

## Required info before scaffolding

Ask only what you can't infer from the user's request:

- **Plugin id** — kebab-case, prefixed by stage: `source-greenhouse`, `enricher-contacts-pattern`, `actor-apply-greenhouse`, etc.
- **Stage** — one of `source | enricher | matcher | tailor | actor | tracker`
- **Allowed domains** — hosts the plugin's `ctx.http` is permitted to reach (empty array if it only uses `ctx.llm` / `ctx.gmail`)
- **Side effects** — `none` for everything except actors; actors are always `external`

## What to create

```
plugins/<id>/
  package.json          # @jobforge/<id>, workspace:* deps on plugin-sdk + shared
  tsconfig.json         # extends ../../tsconfig.base.json
  src/
    index.ts            # exports { manifest, <stage method> }
    config.ts           # zod schema for the plugin's config
  src/index.test.ts     # at minimum: manifest validates, config schema accepts a good example
```

## Rules the scaffold must respect (from PLAN.md §4)

- Depend **only** on `@jobforge/plugin-sdk` and `@jobforge/shared`. Never on `@jobforge/core` or `@jobforge/db`.
- `manifest.permissions.domains` must be a non-wildcard list of exact hosts. Anything not listed is rejected by `ctx.http`.
- Actors must implement **both** `prepare()` (no side effects) and `execute(draft, idempotencyKey)` (only callable with an `ApprovedDraft` the core constructs).
- `dryRun` is true by default; actors must branch on `ctx.dryRun` and log the no-op case.
- No direct `fetch()` or `axios` — always `ctx.http`. No `console.log` — always `ctx.log`.

## After scaffolding

1. `pnpm install` so the workspace picks the new package up.
2. `pnpm --filter @jobforge/<id> typecheck && pnpm --filter @jobforge/<id> test`
3. If a real external API is involved: fetch one sample response, save it under `plugins/<id>/fixtures/`, and point the test at it. Do not hit the live endpoint in CI.
4. Mention the new plugin in `CHANGELOG.md` under the current phase section.