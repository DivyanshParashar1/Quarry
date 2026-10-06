# Changelog

## [Phase 0] — Scaffold

- pnpm monorepo with workspaces (`apps/*`, `packages/*`, `plugins/*`).
- TypeScript strict (NodeNext, ES2023), ESLint flat config, Prettier, Vitest.
- `docker-compose.yml` with `pgvector/pgvector:pg16`.
- `packages/db` — Drizzle schema for `companies`, `company_sources`, `jobs`, `raw_postings`, `plugin_runs`, `events`; migrator that enables the `vector` extension.
- `packages/shared` — zod-validated env loader (`loadEnv`), pino logger, typed error classes.
- `packages/plugin-sdk`, `packages/core`, `packages/llm`, `packages/embeddings` — type stubs so workspace imports are stable before Phase 1 fills them in.
- `apps/server`, `apps/cli`, `apps/mcp`, `apps/web` — scaffolds.
- `.env.example`, `.gitignore`, `.nvmrc` (Node 22), `CLAUDE.md`.

## [Phase 1] — Spine + first sources

- `packages/plugin-sdk` — full plugin contract: manifest schema (exact-host domain allowlist, semver, actors must be `external`), `PluginContext`, `RawPosting` zod schema, all six stage interfaces, branded `ApprovedDraft`, `HttpError`/`DomainNotAllowedError`, `decodeEntities`; `@jobforge/plugin-sdk/testing` with `fixtureHttp` so plugin tests never touch the network.
- `packages/core`
  - `DomainRateLimiter` / `TokenBucket`: one FIFO token bucket per host, shared across plugins; the stricter limit wins.
  - `createScopedHttp`: allowlist enforced on every redirect hop, https only, timeouts, retry with exponential backoff + `Retry-After` on 408/425/429/5xx, no retry on other 4xx.
  - `loadPlugin` / `PluginRegistry` / `buildContext`: manifest, stage-method and config validation; plugins get only the scoped context.
  - Normalizer: HTML→markdown, title/company/location normalization, seniority heuristic, placeholder-location filtering, sha256 fingerprint (company + title + primary location).
  - `runSourceTarget`: fetch → validate → normalize → dedup upsert → close stale jobs, with `plugin_runs` and `events` rows; never throws for plugin failures.
  - pg-boss `source.fetch` queue: one job per board; permanent failures (e.g. 404 board) complete without retry.
- `packages/db` — migration `0001` (`raw_postings.company_source_id`, `last_seen_at`, indexes); repositories (`upsertCompany`, `upsertCompanySource`, `listSourceTargets`, `recordPosting`, `closeStaleJobs`, `listJobs`, `countJobs`, plugin run + event helpers); `createDb`, `runMigrations`; test helpers that clone a migrated template DB per test file.
- `plugins/source-greenhouse` (2 req/s) and `plugins/source-lever` (1 req/s per Lever's robots.txt `Crawl-delay`), coded against recorded fixtures.
- `apps/cli` — `jf companies import <csv> [--skip-invalid]`, `jf companies list`, `jf fetch [--plugin] [--company] [--concurrency]`, `jf jobs list [--company] [--q] [--limit] [--all]`; root `pnpm jf …` script.
- `apps/server` — hosts the `source.fetch` workers with graceful shutdown.
- `data/companies.seed.csv` — 49 boards (40 Greenhouse, 9 Lever) verified against the live APIs.
- Fixes to Phase 0: missing `@eslint/js` dev dependency (lint was failing), root `"type": "module"`.
- Acceptance run (live, 50 boards incl. one dead token): 49/50 ok in ~31s, 9,629 postings → 9,443 canonical jobs; rerun produced 0 new / 0 closed.

## [Phase 2] — LLM layer, profile, matching, review UI

- `packages/llm` — provider-agnostic `LLMClient` (contract in `@jobforge/shared`): per-task routing (`LLM_PROVIDER` default + `config.yaml` overrides), zod-validated structured output with one repair retry, one `llm_calls` row per call.
  - Claude Code CLI adapter: `claude -p --output-format json --json-schema … --permission-mode dontAsk` (never `--bare`), prompt on stdin, empty temp cwd, concurrency cap, timeout + kill, `structured_output`/usage/`total_cost_usd` parsing; `checkClaudeCli` uses `--version` + `auth status` (no model call).
  - OpenRouter adapter: `response_format: json_schema` with `require_parameters`, falls back to JSON-only prompting per model when rejected; reports usage cost.
  - Contract tests run every adapter with its transport faked (fake CLI script, fake fetch); `pnpm --filter @jobforge/llm smoke` for real providers.
- `packages/embeddings` — `bge-small-en-v1.5` via `@huggingface/transformers` (CLS pooling, normalized, 384 dims), bge query prefix for the profile; deterministic hash embedder for tests.
- `packages/db` — migration `0002`: `jobs.embedding vector(384)` (HNSW, cleared when the description changes), `profile_facts` (stable YAML ids, version bump on change, retired not deleted), `profile_snapshots` (content-hash versions), `match_results` (per job × profile version, method `llm|prefilter|filtered`), `llm_calls`; repositories for profile sync, embeddings, ranked listing, job detail, stats.
- Profile — `profile/facts.yaml` + `preferences.yaml` schemas (roles, seniority, locations, remote policy, stack, salary floor, experience years, graduation year, exclusions, notes); `jf profile load|show`.
- `plugins/matcher-default` — hard filters (exclusions, seniority, location/remote, graduation batch, years of experience) → cosine prefilter (`minSimilarity`, `llmTopK`) → batched LLM rubric (stack/seniority/location/eligibility 0–10, score 0–100, reasons, concerns). Jobs the model omits or whose batch fails are left for the next run.
- `packages/core` — context injects the LLM only for plugins declaring `permissions.llm`; `loadProfile`, `embedPending`, `runMatch` (resumable, idempotent per profile version, `plugin_runs` + `events`).
- `plugins/source-ashby` — public posting API, 2 req/s, skips unlisted postings (fixture is synthetic; see its README).
- `apps/server` — Fastify read-only API (`/api/jobs`, `/api/jobs/:id`, `/api/stats`, `/api/profile`, `/api/companies`) on 127.0.0.1, serves the built dashboard, runs source workers.
- `apps/web` — Vite + React + TanStack Query + Tailwind (shadcn-style components): ranked job list with views (Ranked/All/Unscored/Excluded) and filters kept in the URL; job detail with score, rubric bars, concerns, provider/model, description.
- CLI — `jf embed`, `jf match [--rescore] [--limit] [--no-embed]`, `jf llm check`; `jf jobs list` sorts by score.
- `config.example.yaml`; root scripts `pnpm server`, `pnpm web:dev`, `pnpm web:build`.
- Fix: `pnpm db:migrate` now reads the root `.env`.

## [Phase 3] — Outreach

- `packages/db` — migration `0003`: `contacts`, `review_items` (pending → approved → executed; rejected/failed/cancelled), `actions` (unique idempotency key), `outreach_threads`, `app_state`; company mail domain/MX/pattern columns; repositories incl. send-cap queries and a lease lock.
- `packages/plugin-sdk` — `DnsResolver` and `GmailHandle` capabilities (`permissions.dns`, `permissions.gmail` scopes), `Company` with contacts, `CompanyEnrichment`, `OutreachActionInput`, `EmailDraft` schemas, typed `ActorPlugin<C, I, D, R>`; `fakeGmail` and an RFC 5322 parser for tests.
- `packages/core`
  - Capabilities injected only when declared; Gmail narrowed to the declared scopes; cached MX resolver; rate-limited Gmail client and OAuth helpers (`@googleapis/gmail`).
  - `enrichContacts` (persists mail domain, pattern, inferred addresses; never overwrites manual ones).
  - Outreach engine: `draftOutreach`, `editDraft`, `approveReviewItem` / `rejectReviewItem`; only the core mints an `ApprovedDraft`, from an approved row. `runSendTick`: dry run previews; live sends one email per tick under a lease, enforcing the daily cap (20), 2 people/company/7 days (explicit per-item override), randomized spacing, a status re-check right before sending, and 3 attempts before failing. `draftDueFollowups` (max 2, 5 then 7 days), `pollTracker` (reply → thread replied, follow-ups cancelled, address confirmed; bounce → contact bounced). pg-boss schedules for these loops (send loop only in `MODE=live`).
- `plugins/enricher-contacts-pattern` — pattern inference from trusted known addresses with priors fallback (≤ 40% confidence), bounce evidence, MX gate, no SMTP probing.
- `plugins/actor-gmail-outreach` — grounded LLM drafts (placeholder/length checks drive the repair retry, unknown fact ids dropped, signature appended, follow-ups in-thread); plain-text MIME with CR/LF-stripped headers and a Message-ID derived from the idempotency key; a retry searches Sent first and never resends.
- `plugins/tracker-gmail` — read-only inbox poll classifying replies and bounces, ignoring auto-replies.
- `apps/cli` — `jf gmail auth|status` (loopback OAuth with state check; refresh token written to `.env`, mode 600), `jf contacts add|list|enrich`, `jf review list|show|edit|approve|reject`, `jf outreach draft|send [--live] [--watch]|followups|track|threads`; id prefixes accepted.
- `apps/server` — review/contacts/outreach/pipeline/company/source/profile-fact endpoints; loopback-host check and `x-jobforge` + same-origin requirement for writes (DNS-rebinding and CSRF guards).
- `apps/web` — Review tab (edit, save, approve with confirmation, company-cap override, reject/cancel) and per-job Outreach panel (contacts, add, find emails, draft).
- `apps/mcp` — MCP server over stdio with the PLAN §6 tools (minus `discover_ats`, Phase 5) plus `add_contact`, `find_emails`, `draft_outreach`; `approve` is destructive-annotated and confirms via elicitation; `.mcp.json`.
- `profile_update_fact` edits `facts.yaml` in place, keeping comments.
- `docs/outreach.md` — Gmail setup and the draft → approve → send → track flow.
