# Architecture

Quarry is a single-user, self-hosted system. One Postgres database holds the data, the embeddings (pgvector)
and the job queue (pg-boss). One Node process — the Fastify server — serves the API and dashboard and runs the
workers. The CLI and the MCP server are thin clients: the CLI talks to the database through the same core
packages, the MCP server talks to the HTTP API.

```
            ┌────────── apps/web (React) ──────────┐
 you ──────►│ dashboard                             │
            └───────────────┬───────────────────────┘
 Claude Code ── apps/mcp ───┤ HTTP
                            ▼
 apps/cli ───────────► apps/server (Fastify + pg-boss workers)
      │                     │
      └──────────┬──────────┘
                 ▼
         packages/core ── plugin host ──► plugins/* (source, enricher, matcher, tailor, actor, tracker)
                 │                                │
                 ▼                                ▼ ctx.http / ctx.llm / ctx.gmail / ctx.browser
         packages/db (Drizzle)               the outside world (rate-limited, domain-scoped)
                 │
                 ▼
         Postgres 16 + pgvector + pg-boss
```

## Stages

| Stage | Contract | Plugins |
|---|---|---|
| Source | `fetch(ctx, target) → AsyncIterable<RawPosting>` | `source-greenhouse`, `-lever`, `-ashby`, `-smartrecruiters`, `-workday`, `-successfactors`, `-taleo`, `-gmail-alerts` |
| Enricher | `enrich(ctx, job, company) → Enrichment` | `enricher-contacts-pattern`, `enricher-deadline`, `enricher-linkedin-employees` (dormant) |
| Matcher | `score(ctx, jobs[], profile) → MatchResult[]` (batched) | `matcher-default` |
| Tailor | `tailor(ctx, job, profile) → TailoredArtifacts` | `tailor-resume-latex` |
| Actor | `prepare(ctx, input) → ActionDraft` (no side effects), `execute(ctx, ApprovedDraft, idempotencyKey)` | `actor-gmail-outreach`, `actor-linkedin-manual`, `actor-apply-*`, `actor-linkedin-referral` (dormant) |
| Tracker | `poll(ctx, since) → AsyncIterable<TrackEvent>` | `tracker-gmail`, `tracker-linkedin` (dormant) |

Plugins depend only on `@quarry/plugin-sdk` and `@quarry/shared`. Everything they touch comes through a
`PluginContext` the core injects: `config`, a domain-scoped rate-limited `http`, and — only if the manifest asks
for it — `llm`, `embed`, `browser`, `gmail`, `dns`, `credentials`. See [plugins.md](plugins.md).

## Event chain

Each stage writes its result and an `events` row, and enqueues the next stage:

```
discovery.nightly ─► source.fetch ─► jobs.new ─► match ─► job.matched
   ─► resume.select ─► (skills rewrite) ─► resume.ready
   ─► referral.fanout ─► sends (email; LinkedIn by hand) ─► follow-up (24 h)
   ─► referral.replied | deadline.imminent | wait elapsed ─► apply ─► applied | failed
any *.failed / stuck state / failed health check ─► orchestrator
```

The **sweeper** (on server start and hourly) re-derives the same work from database state, so a missed event
costs latency, never a lost job. It runs under a lease, so overlapping runs are harmless.

## Background loops (server)

| Loop | Schedule | Notes |
|---|---|---|
| `sweeper.hourly` | on start + hourly (`sweeper.intervalMinutes`) | board fetch (boards older than `fetchEveryHours`), alerts, reply tracking, deadline expiry; LLM steps only with `autopilot.enabled` |
| `source.alerts` | every 30 min | job-alert emails, when Gmail is connected |
| outreach send / track | every minute / 10 min | send only with `MODE=live` |
| `apply.send` | every 5 min | `MODE=live` only |
| `discovery.nightly`, `discovery.recheck` | 03:41, 04:13 | read-only public pages; `discovery.nightly: false` turns them off |
| `deadlines.nightly` | 02:23 | only with `deadlines.nightly: true` (costs LLM calls) |
| orchestrator | every 15 min + on failure events | `orchestrator.enabled` |
| `linkedin.send` / `linkedin.track` | 1 min / 30 min | only with `LINKEDIN_ENABLED=true` and `MODE=live` |

## Per-job state machine

```
candidate ──► referral_pending ──► ready_to_apply ──► applied
    │               │                    │
    └───────────────┴────────────────────┴──► expired | failed
```

- **candidate** — passed the match score and resume gates.
- **referral_pending** — referral asks fanned out; waiting for a reply, `referralWaitDays`, or a near deadline.
- **ready_to_apply** — an application draft is queued for review.
- Closed postings and passed deadlines move jobs to **expired**. Details: [autopilot.md](autopilot.md).

## Data model (main tables)

| Table | Holds |
|---|---|
| `companies`, `company_sources` | companies and each ATS board they use (`ats_type`, `board_token`/tenant, status, last fetch) |
| `raw_postings` | every posting as fetched, with a fingerprint and its canonical job |
| `jobs` | canonical jobs: title, locations, remote policy, seniority, description, apply URL, embedding, inferred deadline |
| `match_results` | score 0–100, rubric (stack, seniority, location, eligibility), reasons, provider/model |
| `profile_facts`, `profile_snapshots` | the loaded fact bank and preferences, versioned |
| `resume_variants`, `job_resume` | rendered resumes (fit result, ATS score, source) and which one each job uses |
| `contacts`, `contact_imports` | people, email + confidence, LinkedIn URL, degree, source |
| `review_items` | every draft awaiting a decision: `referral_ask`, `outreach`, `followup`, `application`, `attention` |
| `actions` | executed side effects keyed by a unique idempotency key |
| `outreach_threads`, `job_referral_batches` | sent threads and their state; per-job referral batch counts |
| `job_pipeline_state` | the state machine above |
| `incidents` | orchestrator findings and actions |
| `llm_calls`, `plugin_runs`, `events` | cost/latency log, run log, append-only audit log |

### Dedup

Fingerprint = hash(normalized company + normalized title + primary location). On a fingerprint collision the
description embeddings are compared before merging. Every raw posting stays linked to its canonical job.

## Where the LLM is used

Match rubric (top-K only) · resume skills rewrite · bullet shortening when the one-page fit runs out of
typography room · referral and follow-up messages · spreadsheet column mapping (only when heuristics fail) ·
free-text application answers · deadline inference (with web search) · company-list extraction ·
orchestrator diagnosis.

Everything else — filters, resume selection, ATS scoring, the fit loop, the sweeper, the state machine, OTP
extraction — is deterministic. All LLM output is structured, zod-validated (one repair retry), and logged to
`llm_calls` with tokens and cost.

### Providers

`packages/llm` has two adapters behind one interface:

- **claude-code** — spawns your logged-in `claude` CLI in non-interactive JSON-schema mode from an empty temp
  directory (no project config leaks in). Uses your Claude subscription. Concurrency 2, 120 s timeout by default.
- **openrouter** — OpenAI-compatible API with `OPENROUTER_API_KEY`; JSON-schema responses where the model
  supports them.

`LLM_PROVIDER` picks the default; `config.yaml` `llm.tasks.<task>` can route a task (`match`, `tailor`,
`outreach`, `extract`, `research`, `orchestrator`) to another provider or model.

## Safety enforcement points

See [safety.md](safety.md) for the full list. The short version: `ApprovedDraft` is minted only by the core from
an approved review item; `dryRun` comes from `MODE`/`--live`; `ctx.http` enforces each plugin's domain allowlist
and per-domain rate limits; idempotency keys are unique in `actions`.
