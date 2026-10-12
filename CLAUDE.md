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
- LinkedIn outreach is manual (Phase 17, user decision: never risk the account): fan-out drafts messages/notes with `actor-linkedin-manual` and the user sends them by hand; never add automated LinkedIn sends to fan-out. The older automation stays dormant: only with `LINKEDIN_ENABLED=true` AND a live run, on the user's dedicated account; any checkpoint/captcha/login wall pauses all LinkedIn loops and raises an `attention` review item — no retries.

## Repo map (quick)
- `apps/server` — Fastify API + pg-boss workers
- `apps/web` — React dashboard (Vite; built into `apps/web/dist`, served by the server)
- `apps/mcp` — MCP server (stdio; thin wrapper over the HTTP API)
- `apps/cli` — `quarry` CLI
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
- `pnpm quarry companies import data/companies.seed.csv` / `pnpm quarry fetch` / `pnpm quarry jobs list`
- `pnpm quarry profile load` / `pnpm quarry embed` / `pnpm quarry match [--rescore]` / `pnpm quarry llm check`
- `pnpm web:build && pnpm server` → dashboard at http://localhost:3000 (`pnpm web:dev` for Vite on :5173)
- `pnpm --filter @quarry/llm smoke -- --provider claude-code|openrouter` — real-provider smoke test (costs money; manual only)
- Outreach: `pnpm quarry gmail auth`, `quarry contacts add|enrich`, `quarry outreach draft`, `quarry review list|approve`, `quarry outreach send [--live]`, `quarry outreach track` — see `docs/outreach.md`
- Referrals: `quarry referrals fanout|show|approve <jobId>`, `quarry linkedin login|status|resume|employees` (Phase 8, dormant)
- Contacts (Phase 17): `quarry contacts import <file.xlsx|.csv> [--yes]` (LinkedIn Connections.csv too), `quarry linkedin drafts [--job] | sent <id> | replied <id>`; dashboard Contacts tab
- Resumes (Phase 16): `quarry resumes generate [--retire] | list | bench [--pick]`, `quarry tailor <jobId> [--force]` (selector: best library combo + skills-only rewrite); dashboard Resumes tab
- Sweeper (Phase 18): `quarry sweep [--live]` runs the server's hourly pass (also on server start); LLM steps only with `autopilot.enabled`; stage events trigger the next stage when autopilot is on
- Applications (Phases 19–21): Greenhouse/Lever/Ashby/SmartRecruiters/Workday/SuccessFactors/Taleo auto-apply. Workday/SF/Taleo share `plugin-sdk/wizard.ts`: per-tenant account (password in the OS keychain), consent (`consent:terms`) must be Yes on the draft, dry run stops at Review, overrides in `plugins.<actor>.tenants`, failed steps captured in `data/apply-failures/`, unrecognised pages → attention item with screenshots; emailed verification codes read from Gmail; blank questions answered from the answer bank then the LLM (never salary/notice/visa/authorization/EEO); `quarry answers [list] | delete <id>`
- Phone fetcher (Phase 24): `pnpm fetcher run [--every <h>] [--full] [--no-filter] | status` — fetch-only, no DB; writes batches to `data/fetcher/outbox/` for the laptop (`docs/phone-fetcher.md`)
- Discovery: `quarry discover_ats <domain|name> [--save] | --missing`, `quarry discover_companies --list yc|gcc-journal|…` (Phase 6)
- Orchestrator (Phase 22): `quarry orchestrator run`, `quarry incidents [--all]`; dashboard Health tab; config `orchestrator.*` (budget, thresholds); push alerts via `NTFY_URL`. Server runs ops actions only (automatic code fixes not wired into the server).
- MCP: `.mcp.json` registers `apps/mcp` (needs `pnpm server` running). Never allowlist the `approve` tool.
- Chatbot: dashboard Chat tab (`docs/chatbot.md`) — Claude Code with the MCP tools (no approve), web, scripts; its code changes are gated (protected paths, typecheck/lint/tests) before merging. Config `chat.*`.
- Test scripts: `pnpm smoke:api` (needs `pnpm server`), `pnpm smoke:cli [--network]`, `pnpm live:sources` (read-only, real boards) — see `docs/testing.md`
- DB tests need Postgres up; they skip with a warning otherwise (`QUARRY_REQUIRE_DB=1` makes that a failure)
