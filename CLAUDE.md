# CLAUDE.md — Agent working rules

Short, operational rules. Full context lives in `PLAN.md`.

## Working rules
- Read `PLAN.md` before starting. Work only on the current phase. Stop at the end of a phase for review.
- Prefer small, reviewable commits with clear messages.
- Never add a `Co-Authored-By` trailer (or any other AI attribution line) to commit messages or PR descriptions.
- Write tests alongside code. External HTTP is tested against recorded fixtures, never live endpoints in CI.
- Do not add a dependency that is not listed in PLAN.md section 2 without noting it (and the reason) in the phase summary.
- Never send real email, submit real forms, or call paid APIs during development unless the user explicitly asks in the session.
- When an external API's shape is uncertain, fetch and inspect it first, then save a fixture.
- At the end of a phase: run the full test suite, update `CHANGELOG.md`, write a short phase summary, and stop.

## Hard safety rules (enforced in code too)
- No external side effect without an approved `review_items` row. Actors only run `execute()` with an `ApprovedDraft` constructed by the core.
- `dryRun` defaults to true outside an explicit `--live` flag or `MODE=live`.
- Secrets live in `.env` or the OS keychain; never log them; never store them in `events`.
- Respect per-domain rate limits on every outbound request. Respect `robots.txt` for careers-page scraping.
- Outreach throttles (PLAN-phases-6-13, user-approved): no global daily cap and no per-company weekly cap by default (both stay available as opt-in config). Always enforced: a person is never asked twice within `perContactCooldownDays` (30) across any job/channel; a job gets at most its batch's referral cap (10); sender technical limits (Gmail `senderDailyLimit`, LinkedIn `dailyConnectionCap` 25/day).
- LinkedIn automation only with `LINKEDIN_ENABLED=true` AND a live run, on the user's dedicated account; any checkpoint/captcha/login wall pauses all LinkedIn loops and raises an `attention` review item — no retries.

## Repo map (quick)
- `apps/server` — Fastify API + pg-boss workers
- `apps/web` — React dashboard (Vite; built into `apps/web/dist`, served by the server)
- `apps/mcp` — MCP server (stdio; thin wrapper over the HTTP API)
- `apps/cli` — `jf` CLI
- `packages/core` — pipeline engine, plugin host, rate limiter, idempotency
- `packages/db` — Drizzle schema, migrations, repositories
- `packages/plugin-sdk` — types + helpers for plugin authors
- `packages/llm` — LLM provider interface + adapters
- `packages/embeddings` — local embedding service
- `packages/shared` — zod schemas, logging, config
- `plugins/*` — individual source/enricher/matcher/tailor/actor/tracker plugins
- `profile/` — `facts.yaml` and `preferences.yaml`

## Commands
- `pnpm i`
- `docker compose up -d`
- `pnpm db:migrate`
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm jf companies import data/companies.seed.csv` / `pnpm jf fetch` / `pnpm jf jobs list`
- `pnpm jf profile load` / `pnpm jf embed` / `pnpm jf match [--rescore]` / `pnpm jf llm check`
- `pnpm web:build && pnpm server` → dashboard at http://localhost:3000 (`pnpm web:dev` for Vite on :5173)
- `pnpm --filter @jobforge/llm smoke -- --provider claude-code|openrouter` — real-provider smoke test (costs money; manual only)
- Outreach: `pnpm jf gmail auth`, `jf contacts add|enrich`, `jf outreach draft`, `jf review list|approve`, `jf outreach send [--live]`, `jf outreach track` — see `docs/outreach.md`
- Referrals: `jf referrals fanout|show|approve <jobId>`, `jf linkedin login|status|resume|employees` (Phase 8)
- Resumes (Phase 16): `jf resumes generate [--retire] | list | bench [--pick]`, `jf tailor <jobId> [--force]` (selector: best library combo + skills-only rewrite); dashboard Resumes tab
- Discovery: `jf discover_ats <domain|name> [--save] | --missing`, `jf discover_companies --list yc|gcc-journal|…` (Phase 6)
- MCP: `.mcp.json` registers `apps/mcp` (needs `pnpm server` running). Never allowlist the `approve` tool.
- DB tests need Postgres up; they skip with a warning otherwise (`JOBFORGE_REQUIRE_DB=1` makes that a failure)
