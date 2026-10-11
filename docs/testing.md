# Testing Quarry

Four layers, cheapest first. Nothing here sends email, submits an application, approves a review item or spends LLM
money unless the line says so.

| Command | What it covers | Needs |
|---|---|---|
| `pnpm test` | Unit + integration suites (vitest, recorded fixtures only, no live HTTP). `*.db.test.ts` need Postgres; `QUARRY_REQUIRE_DB=1` turns a missing DB into a failure. | `docker compose up -d` |
| `pnpm typecheck && pnpm lint` | Types and lint across the workspace. | — |
| `pnpm smoke:cli [--network]` | Runs every read-only `quarry` command against your DB and checks exit codes / no stack traces. `--network` adds Gmail status + alert parsing (read-only), `discover_ats`, a YC list dry run. | DB; Gmail for `--network` |
| `pnpm smoke:api [--base URL] [--no-ops]` | Against a **running** server: every read endpoint, the built dashboard, the CSRF guard (no `x-quarry` header / foreign origin → 403), unknown routes → 404, and one orchestrator pass (ops actions only). | `pnpm server` |
| `pnpm live:sources [--save dir]` | Phase 23 read-only: each source plugin against one real public board through the scoped HTTP + rate limits; nothing written to the DB. | network |

## What the vitest suites guarantee

- **Every HTTP route** (`apps/server/src/api-coverage.db.test.ts`): the route list Fastify registered must equal the
  smoke table — a new route without an entry fails — and each is called once against a seeded DB: never a 500, always
  one of the expected codes (503 where the server didn't get that dependency; behaviour with it is in the
  `api-*.db.test.ts` files).
- **Every MCP tool** (`apps/server/src/mcp-contract.db.test.ts`): each tool is called through the real HTTP API with
  arguments generated from its input schema; every request it makes must match a registered route and method, and none
  may answer 500. (This found `profile_update_fact` sending PUT where the server has PATCH.)
- **Features**: per-feature suites next to the code — sources and apply actors against recorded fixtures, the review →
  approve → act loop, outreach caps/cooldowns, referrals, sequencer, sweeper, resume engine and ATS scores, contact
  import, answers/OTP, the account wizard (Workday / SuccessFactors / Taleo), the orchestrator's injected faults
  (`packages/orchestrator/src/orchestrator.db.test.ts`), and the chatbot's guardrails.
