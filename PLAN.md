# JobForge: Build Plan

> Working name. Rename freely.
> This document is the source of truth for the coding agent. Read it fully before writing code. Work one phase at a time, and stop at the end of each phase for review.

---

## 1. What we are building

A self-hosted, plugin-based system that runs a job search as a pipeline:

```
Source -> Normalize & Dedup -> Enrich -> Match -> Tailor -> Review -> Act -> Track
```

- **Source** plugins fetch job postings (ATS job boards, job-alert emails, careers pages).
- **Normalize & Dedup** turns raw postings into canonical jobs and merges duplicates across sources.
- **Enrich** adds company metadata and finds contacts (recruiters, engineers, founders).
- **Match** scores each job against the candidate profile and explains the score.
- **Tailor** produces a grounded resume variant and outreach drafts for a job.
- **Review** is a human approval queue. Nothing with an external side effect happens without approval.
- **Act** plugins submit applications or send emails.
- **Track** watches for replies, schedules follow-ups, and cancels sequences on reply.

The optimization target is **quality applications per hour of the user's time**, not raw volume.

### Non-goals (for now)
- No automation of LinkedIn or Naukri websites (ToS and account-ban risk). Their content enters only via job-alert emails.
- No multi-tenant SaaS. Single user, runs on the user's machine (on-prem). An optional "API mode" only changes the LLM provider.
- No CAPTCHA solving, no credential stuffing, no aggressive SMTP probing.

---

## 2. Tech stack (Phase 0 decisions)

| Concern | Choice | Why |
|---|---|---|
| Language / runtime | TypeScript (strict), Node 22 LTS | User's primary stack |
| Monorepo | pnpm workspaces | Simple, fast, no extra build orchestrator needed yet |
| Database | PostgreSQL 16 + `pgvector` | One store for relational data, embeddings, and the job queue |
| ORM / SQL | Drizzle ORM + drizzle-kit migrations | Type-safe, stays close to SQL |
| Job queue | `pg-boss` (Postgres-backed) | Durable, transactional with app data, no Redis to run on-prem |
| Validation | `zod` everywhere (plugin config, manifests, LLM outputs, API) | Single schema language; converts to JSON Schema for LLM calls |
| HTTP API | Fastify | Fast, schema-friendly |
| Web UI | React + Vite + TanStack Query + Tailwind + shadcn/ui | SPA served by Fastify; review queue and dashboards |
| Embeddings | Local, via `@huggingface/transformers` (`bge-small-en-v1.5`, 384 dims) | Free, offline, no provider dependency |
| LLM | Provider interface with two adapters: **Claude Code CLI** (on-prem mode) and **OpenRouter** (API mode) | See section 5 |
| Agent integration | MCP server using `@modelcontextprotocol/sdk` | Lets an interactive Claude Code session steer the system |
| Browser automation | Playwright (Chromium) | Form-fill for Greenhouse / Lever / Ashby applications |
| Email | Gmail API via `googleapis` (OAuth, user's own account) | Sending, thread tracking, reading job-alert emails |
| Resume rendering | Typst CLI | Clean templating, fast PDF output |
| Logging | pino | Structured logs |
| Testing | Vitest; Testcontainers (or docker compose) for Postgres integration tests | |
| Local infra | docker compose: `postgres` (with pgvector) | |
| Lint / format | ESLint (typescript-eslint) + Prettier | |

If any of these turns out to be blocking, propose an alternative in the phase summary instead of silently switching.

---

## 3. Repository layout

```
jobforge/
  apps/
    server/            # Fastify API, pg-boss workers, pipeline orchestration
    web/               # React review dashboard
    mcp/               # MCP server exposing system tools to Claude Code
    cli/               # `jf` command: run pipeline, seed companies, manage plugins
  packages/
    core/              # pipeline engine, plugin host, rate limiter, idempotency
    db/                # drizzle schema, migrations, repositories
    plugin-sdk/        # types + helpers plugin authors import (manifest, context, contracts)
    llm/               # LLM provider interface + claude-code + openrouter adapters
    embeddings/        # local embedding service
    shared/            # zod schemas, domain types, utils
  plugins/
    source-greenhouse/
    source-lever/
    source-ashby/
    source-gmail-alerts/
    enricher-contacts-pattern/
    matcher-default/
    tailor-resume-typst/
    actor-gmail-outreach/
    actor-apply-greenhouse/
    ...
  profile/
    facts.yaml         # the candidate fact bank (see section 7)
    preferences.yaml   # roles, locations, stack, salary floor, exclusions
  templates/
    resume.typ
  docker-compose.yml
  PLAN.md
  CLAUDE.md            # short agent working rules, derived from section 10
```

Plugins depend only on `@jobforge/plugin-sdk` and `@jobforge/shared`, never on `core` or `db` directly.

---

## 4. Plugin contract

### 4.1 Manifest

Every plugin exports a manifest validated by zod at load time:

```ts
export interface PluginManifest {
  id: string;                    // "source-greenhouse"
  version: string;               // semver
  stage: "source" | "enricher" | "matcher" | "tailor" | "actor" | "tracker";
  description: string;
  configSchema: z.ZodTypeAny;    // validated before the plugin runs
  permissions: {
    domains: string[];           // hosts the plugin's ctx.http may reach; anything else is rejected
    llm?: boolean;
    browser?: boolean;
    gmail?: ("read" | "send")[];
  };
  rateLimit?: { perDomain: { tokens: number; intervalMs: number } };
  sideEffects: "none" | "external"; // "external" => core requires an approved ReviewItem before execute()
}
```

### 4.2 Context (injected by the core, never constructed by plugins)

```ts
export interface PluginContext<C> {
  config: C;
  http: ScopedHttp;        // fetch wrapper: enforces permissions.domains + per-domain token bucket + retries
  llm?: LLMClient;         // only if permissions.llm
  embed?: Embedder;
  browser?: BrowserHandle; // only if permissions.browser
  gmail?: GmailHandle;     // scoped to declared gmail permissions
  log: Logger;
  signal: AbortSignal;     // core cancels on timeout/shutdown
  dryRun: boolean;         // true by default in development
}
```

### 4.3 Stage contracts

```ts
interface SourcePlugin<C> {
  manifest: PluginManifest;
  // targets come from company_sources rows (e.g. a Greenhouse board token)
  fetch(ctx: PluginContext<C>, target: SourceTarget): AsyncIterable<RawPosting>;
}

interface EnricherPlugin<C> {
  manifest: PluginManifest;
  enrich(ctx: PluginContext<C>, job: Job, company: Company): Promise<Enrichment>;
}

interface MatcherPlugin<C> {
  manifest: PluginManifest;
  score(ctx: PluginContext<C>, jobs: Job[], profile: Profile): Promise<MatchResult[]>; // batched
}

interface TailorPlugin<C> {
  manifest: PluginManifest;
  tailor(ctx: PluginContext<C>, job: Job, profile: Profile): Promise<TailoredArtifacts>;
}

interface ActorPlugin<C> {
  manifest: PluginManifest;            // sideEffects: "external"
  prepare(ctx: PluginContext<C>, input: ActionInput): Promise<ActionDraft>;   // no side effects
  execute(ctx: PluginContext<C>, draft: ApprovedDraft, idempotencyKey: string): Promise<ActionResult>;
}

interface TrackerPlugin<C> {
  manifest: PluginManifest;
  poll(ctx: PluginContext<C>, since: Date): AsyncIterable<TrackEvent>; // replies, bounces, status changes
}
```

### 4.4 Core guarantees
- `execute()` is only callable with an `ApprovedDraft`, which the core constructs from an approved `review_items` row. Plugins cannot construct one.
- Each `execute()` is keyed by an idempotency key stored in `actions`; a retried job never repeats a completed side effect.
- In `dryRun` mode, actors log what they would do and return a synthetic result.
- Plugins run in-process in Phase 1 behind the `PluginContext` boundary. Process isolation (worker threads or child processes) is a later phase; do not leak core objects into plugins so the move is mechanical.

---

## 5. LLM layer

### 5.1 Interface

```ts
export interface LLMClient {
  generate<T>(req: {
    task: LLMTask;               // "match" | "tailor" | "outreach" | "extract" | ...
    system: string;
    prompt: string;
    schema: z.ZodType<T>;        // converted to JSON Schema for the provider
    maxTokens?: number;
  }): Promise<{ data: T; usage: Usage; provider: string; model: string }>;
}
```

- All LLM outputs are structured and zod-validated. On validation failure: one repair retry, then fail the job.
- Model routing is per task in config, e.g. a cheap model for `match`, a stronger one for `tailor`.
- Every call is logged to `llm_calls` (task, provider, model, tokens, cost estimate, latency, success).

### 5.2 Adapter A: Claude Code CLI (on-prem mode)

Uses the user's locally installed and logged-in `claude` CLI in non-interactive mode. Spawn per request:

```
claude -p --output-format json --json-schema '<schema>' --model <model> \
  --system-prompt '<system>' --permission-mode dontAsk
```

- Prompt is written to stdin (stdin cap is 10MB; use files for anything larger).
- Run with `cwd` set to an empty temp directory so no project CLAUDE.md, hooks, or `.mcp.json` are loaded.
- Do **not** pass `--bare` (bare mode ignores the subscription login and requires `ANTHROPIC_API_KEY`).
- Read `structured_output` from the JSON result; check exit code; capture `total_cost_usd` for logging.
- Concurrency cap (default 2) and a per-call timeout (default 120s). Each spawn has startup overhead, so matcher calls must be batched (e.g. 10 to 20 jobs per call).
- Detect missing CLI or failed auth at startup and report clearly.
- Intended for personal, local use only.

### 5.3 Adapter B: OpenRouter (API mode)

- OpenAI-compatible client pointed at `https://openrouter.ai/api/v1` with `OPENROUTER_API_KEY`.
- Use `response_format: { type: "json_schema", ... }` where the chosen model supports it; otherwise fall back to "JSON only" prompting plus zod validation and repair.
- Model IDs configurable per task.

### 5.4 Selection

`LLM_PROVIDER=claude-code | openrouter` in `.env`, overridable per task in `config.yaml`. The rest of the system never knows which one is active.

---

## 6. MCP server (Claude Code as the guiding agent)

`apps/mcp` exposes the running system to an interactive Claude Code session started in the repo. Register it in the project's `.mcp.json`. Tools (all thin wrappers over the server's HTTP API):

- `pipeline_status`: counts per stage, failing jobs, last run per plugin
- `list_jobs(filter)`: search canonical jobs with match scores
- `get_job(id)`: full job, match reasoning, contacts, drafts
- `run_source(pluginId, targets?)`: trigger a fetch
- `review_queue(limit)`: pending approvals
- `edit_draft(id, patch)`: modify an outreach or application draft
- `approve(id)` / `reject(id, reason)`: decide review items
- `add_company(name, atsType, boardToken)` / `discover_ats(companyName)`: grow the company list
- `profile_get` / `profile_update_fact`: read and edit the fact bank

Guardrail: `approve` is the only path to external side effects, and the MCP server must mark it as requiring user confirmation. The agent can prepare and recommend; the user approves.

---

## 7. Domain model (initial tables)

- `companies`: id, name, domain, tags (startup, GCC, fintech...), location, notes
- `company_sources`: company_id, ats_type (greenhouse | lever | ashby | careers_page | other), board_token, last_fetched_at, status
- `raw_postings`: id, source_plugin, external_id, url, payload jsonb, fetched_at, fingerprint, canonical_job_id
- `jobs`: canonical job: company_id, title, normalized_title, locations[], remote_policy, seniority, description_md, apply_url, posted_at, first_seen_at, last_seen_at, closed_at, embedding vector(384)
- `match_results`: job_id, profile_version, score 0..100, rubric jsonb (stack_fit, seniority_fit, location_fit, eligibility), reasons text, provider, model
- `profile_facts`: id, kind (project | experience | education | skill | achievement), content, metrics jsonb, tags[], version
- `resume_variants`: job_id, fact_ids[], rendered bullets jsonb, pdf_path, validation_report jsonb
- `contacts`: company_id, name, role, email, email_confidence, source, linkedin_url
- `review_items`: id, kind (application | outreach | followup), job_id, contact_id, draft jsonb, status (pending | approved | rejected | executed | failed), decided_at
- `actions`: id, review_item_id, plugin_id, idempotency_key unique, status, result jsonb, executed_at
- `outreach_threads`: contact_id, job_id, gmail_thread_id, state (sent | replied | bounced | closed), next_followup_at
- `llm_calls`, `plugin_runs`, `events` (append-only audit log)

### Dedup
Fingerprint = hash(normalized company + normalized title + primary location). On collision, also compare description embeddings (cosine > 0.92) before merging. Keep every raw posting linked to its canonical job.

### Grounded tailoring rule
The tailor may only **select, reorder, and rephrase** facts from `profile_facts`. Every output bullet must carry the `fact_id` it came from, and a validator checks that numbers, technologies, and claims in the bullet exist in the source fact. Failing bullets are dropped and reported. The system must never invent experience.

---

## 8. Phases

Each phase ends with: passing tests, a short summary of what was built, known gaps, and any decisions that need the user. Then stop.

### Phase 0: Scaffold
- pnpm monorepo, TypeScript strict, ESLint/Prettier, Vitest.
- docker compose with Postgres 16 + pgvector.
- `packages/db` with Drizzle and the first migration (companies, company_sources, raw_postings, jobs, plugin_runs, events).
- `.env.example`, config loader (zod-validated), pino logging.
- `CLAUDE.md` with the working rules from section 10.
- **Done when:** `pnpm i && docker compose up -d && pnpm db:migrate && pnpm test` passes on a clean clone.

### Phase 1: Spine + first sources
- `plugin-sdk` types, plugin loader with manifest validation.
- `core`: pg-boss setup, stage workers, ScopedHttp (domain allowlist, token bucket per domain, retries with backoff), plugin_runs logging.
- `source-greenhouse` (public board API, e.g. `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`) and `source-lever` (`api.lever.co/v0/postings/{company}?mode=json`). Verify endpoints and response shapes before coding against them; record fixtures for tests.
- Normalizer + dedup.
- `jf` CLI: `jf companies import <csv>`, `jf fetch [--plugin] [--company]`, `jf jobs list`.
- **Done when:** importing ~50 companies and running `jf fetch` produces deduplicated canonical jobs, rerunning is idempotent, and a failing board doesn't stop the others.

### Phase 2: LLM layer, profile, matching, review UI
- `packages/llm` with both adapters, per-task routing, `llm_calls` logging. Contract tests that run against a fake provider; a manual smoke script for each real provider.
- `profile/facts.yaml` + `preferences.yaml` loaded into `profile_facts`.
- Local embeddings; embed jobs and profile.
- `matcher-default`: hard filters (location, seniority, batch eligibility, exclusions) -> embedding prefilter -> batched LLM rubric with reasons.
- `apps/web`: job list sorted by score with filters, job detail with match reasoning.
- `source-ashby`.
- **Done when:** the user can open the dashboard and see a ranked, explained list of real openings, with either provider selected by config.

### Phase 3: Outreach
- `enricher-contacts-pattern`: infer email patterns (first.last@, first@, etc.) with MX check and a confidence score. Optional provider plugin (Hunter or Apollo free tier) behind the same interface.
- Gmail OAuth flow (local), `actor-gmail-outreach`: LLM-drafted, job-specific email -> review item -> send on approval. Daily send cap (default 20), randomized spacing, dry run by default.
- `tracker-gmail`: detect replies and bounces on sent threads; schedule up to 2 follow-ups; cancel on reply.
- Review queue UI with edit, approve, reject.
- `apps/mcp` with the tools in section 6.
- **Done when:** a real outreach email can be drafted, edited, approved, sent once (idempotent under retry), and its reply detected.

### Phase 4: Tailoring
- `tailor-resume-typst`: fact selection + rephrasing per job, validator, Typst render to PDF, stored in `resume_variants`.
- Outreach drafts can attach or link the tailored resume.
- **Done when:** for a given job, a one-page PDF is produced whose every bullet traces to a fact, with a validation report visible in the UI.

### Phase 5: Applying + more sources
- `actor-apply-greenhouse`, then Lever and Ashby: Playwright form-fill using profile data and the tailored PDF, screenshot before submit, submit only after approval, record the confirmation.
- `source-gmail-alerts`: parse LinkedIn / Naukri / Instahyre job-alert emails into raw postings.
- `discover_ats`: given a company name or domain, detect which ATS its careers page uses.
- **Done when:** an approved application is submitted end to end on a real Greenhouse form with a screenshot audit trail.

### Phase 6 (stretch)
- Plugin process isolation (child processes with an RPC boundary).
- Analytics: funnel per source, reply rate per outreach style, time from posting to application.
- Scheduled runs (daily fetch + match), digest email.

---

## 9. Safety and etiquette rules (enforced in code, not just policy)
- No external side effect without an approved review item. Core-enforced.
- `dryRun` defaults to true outside an explicit `--live` flag or `MODE=live`.
- Per-domain rate limits on every outbound request; respect `robots.txt` for any careers-page scraping.
- Outreach caps per day and per company; never email more than 2 people at the same company in a week without explicit override.
- Secrets only in `.env` / OS keychain; never logged, never stored in `events`.
- Audit log entry for every executed action.

---

## 10. Agent working rules (copy into CLAUDE.md)
- Read PLAN.md before starting. Work only on the current phase.
- Prefer small, reviewable commits with clear messages.
- Write tests alongside code; external HTTP is tested against recorded fixtures, never live endpoints in CI.
- Do not add a dependency that is not in section 2 without noting it and the reason in the phase summary.
- Never send real email, submit real forms, or call paid APIs during development unless the user explicitly asks in the session.
- When an external API's shape is uncertain, fetch and inspect it first, then save a fixture.
- At the end of a phase: run the full test suite, update a `CHANGELOG.md`, write the phase summary, and stop.
