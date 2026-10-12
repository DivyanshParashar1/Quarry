# Quarry

A self-hosted job-search pipeline that runs on your own machine. Quarry finds openings across hundreds of
company job boards, scores each one against your profile, picks and tailors a one-page resume for it, drafts
referral asks to people at the company, and (once you approve) sends them and submits the application. It
also tracks replies, sends one follow-up, and moves each job forward on its own.

```
Source → Normalize & Dedup → Enrich → Match → Tailor → Review → Act → Track
```

Nothing with an external side effect (an email, a LinkedIn message, a submitted application) happens without
an **approved review item**, and everything is a **dry run** until you pass `--live` or set `MODE=live`.

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Daily use](#daily-use)
- [The dashboard](#the-dashboard)
- [Driving it from Claude Code](#driving-it-from-claude-code)
- [Safety model](#safety-model)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Documentation](#documentation)

---

## How it works

Quarry is a pipeline of **plugins**, run by a Fastify server with a Postgres-backed job queue (pg-boss). Each
stage writes its result to Postgres and emits an event that triggers the next stage, so a new posting can go
from "fetched" to "referral asks drafted" without waiting for a timer. An hourly **sweeper** re-derives the same
work from the database, so nothing is lost if the server was off.

| Stage | What happens | Where |
|---|---|---|
| **Source** | Fetches postings from public ATS boards (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, SuccessFactors, Taleo) and from job-alert emails in your Gmail (LinkedIn, Naukri, Wellfound, YC, Instahyre, Internshala, Unstop). | `plugins/source-*` |
| **Discover** | Finds new companies (YC, GCC lists, Wellfound, …) and detects which ATS each one uses. Runs nightly. | `quarry discover_*` |
| **Normalize & dedup** | Turns raw postings into canonical jobs; the same role seen on two boards becomes one job. | `packages/core` |
| **Match** | Hard filters from `preferences.yaml` (location, seniority, batch, exclusions) → local-embedding similarity → a batched LLM rubric with written reasons. Score 0–100. | `plugins/matcher-default` |
| **Tailor** | Picks the best resume from a pre-rendered library (ATS score + similarity to the JD), rewrites only its *Technical Skills* section for the job, and fits it to one page. Every claim traces back to your fact bank. | `plugins/tailor-resume-latex`, `packages/core` |
| **Enrich** | Finds people to ask: your imported contacts and LinkedIn connections first, then pattern-inferred emails (MX-checked). Estimates the application deadline with a web-searching LLM. | `plugins/enricher-*` |
| **Review** | Every outbound draft lands in a review queue. You edit, approve, or reject. Autopilot can auto-approve drafts that clear confidence floors. | dashboard **Review** tab |
| **Act** | Sends approved emails through your Gmail, and fills/submits approved applications with Playwright. LinkedIn messages are drafted for you to send by hand. | `plugins/actor-*` |
| **Track** | Detects replies and bounces, schedules a single 24 h follow-up, and cancels it when someone answers. | `plugins/tracker-*` |

On top of the stages sit three loops:

- **Autopilot / sequencer** — a per-job state machine: `candidate → referral_pending → ready_to_apply → applied`
  (or `expired` / `failed`). A job moves to applying when a referral ask gets a reply, when its deadline is
  near, or after `referralWaitDays` (2) — whichever comes first.
- **Sweeper** — runs on server start and hourly. Free steps (board fetch, alert emails, reply tracking,
  deadline expiry) always run; LLM-spending steps (match, resume, fan-out, follow-ups) only when
  `autopilot.enabled: true`.
- **Orchestrator** — every 15 minutes, deterministic health checks (failing boards, stuck jobs, bounce rate,
  LLM budget, review backlog) open incidents; an LLM "expert" proposes ops actions (retry, pause a board,
  expire a job, raise an attention item). See [docs/orchestrator.md](docs/orchestrator.md).

The LLM is used only where judgment is needed (match rubric, skills rewrite, referral messages, free-text
application answers, deadline estimates, company-list extraction, diagnosis). Filtering, resume selection, ATS
scoring, the one-page fit loop and the state machine are deterministic. The LLM provider is either your local
**Claude Code CLI** (uses your Claude subscription) or **OpenRouter** (API key) — see
[docs/configuration.md](docs/configuration.md#llm-provider).

A longer walkthrough with diagrams is in [docs/architecture.md](docs/architecture.md).

---

## Requirements

| Tool | Why | Notes |
|---|---|---|
| Node.js ≥ 22 | runtime | `.nvmrc` pins it |
| pnpm 11 | monorepo | `corepack enable` |
| Docker | Postgres 16 + pgvector | `docker compose up -d` |
| An LLM | matching, tailoring, drafting | logged-in `claude` CLI **or** an `OPENROUTER_API_KEY` |
| TeX Live (`latexmk`) | resume PDFs | `brew install --cask mactex-no-gui` / `apt install texlive-full latexmk` |
| Playwright Chromium | applying, form previews | `pnpm exec playwright install chromium` |
| Google Cloud OAuth client | Gmail send/read (optional) | see [docs/outreach.md](docs/outreach.md#1-connect-gmail-once) |

Embeddings run locally (`bge-small-en-v1.5`, downloaded once on first `quarry embed`); no embedding API is needed.

---

## Quick start

```bash
git clone <this repo> quarry && cd quarry
pnpm i
cp .env.example .env              # set LLM_PROVIDER, and OPENROUTER_API_KEY if you use OpenRouter
cp config.example.yaml config.yaml
docker compose up -d              # Postgres on :5432
pnpm db:migrate
```

**1. Describe yourself.** Copy the template with `cp -R profile.example profile`, then edit the files in `profile/`
(format: [docs/profile.md](docs/profile.md)). `profile/` is gitignored, so your details never get committed:

- `profile/facts.yaml` — your fact bank: experience, projects, education, skills, achievements. The tailor may
  only select and rephrase these; it never invents experience.
- `profile/preferences.yaml` — target roles, seniority, locations, stack, batch year, exclusions, and the
  `application` block used to fill forms.
- `profile/resume/` — your resume as LaTeX blocks (`blocks/*.tex`) plus `preamble.tex` and `manifest.yaml`.

```bash
pnpm quarry profile load          # validate and activate the profile (re-run after every edit)
pnpm quarry llm check             # confirm the provider is reachable (no model call)
```

**2. Add companies and fetch jobs.**

```bash
pnpm quarry companies import data/companies.seed.csv
pnpm quarry discover_companies --list yc          # optional: grow the list
pnpm quarry fetch
pnpm quarry jobs list
```

**3. Score them.**

```bash
pnpm quarry embed
pnpm quarry match
pnpm quarry jobs list             # now sorted by match score
```

**4. Build your resume library.**

```bash
pnpm quarry resumes generate      # one PDF per combination of projects, each fit to one page
pnpm quarry tailor <jobId>        # best resume for a job + a skills rewrite for its JD
```

**5. Open the dashboard.**

```bash
pnpm web:build && pnpm server     # http://localhost:3000
```

From here, the server fetches, sweeps and tracks on its own. Turn on the LLM steps with
`autopilot.enabled: true` in `config.yaml`; turn on real sends with `MODE=live` in `.env`. The full first-run
guide, including Gmail and contact import, is [docs/getting-started.md](docs/getting-started.md).

---

## Daily use

A typical loop once things are set up:

1. **Leave the server running** (`pnpm server`). It fetches boards every 6 h, reads alert emails every 30 min,
   discovers companies nightly, sweeps hourly and checks its own health every 15 min.
2. **Open the Review tab.** Approve or edit referral asks, follow-ups and application drafts. Anything the
   autopilot was unsure about waits here.
3. **Send LinkedIn messages by hand.** The Contacts tab and job pages list drafted messages with *Copy text*,
   *Open profile*, *Download resume PDF*, then *I sent it* / *They replied*.
4. **Check Health** for incidents that need you (a captcha, an expired Gmail token, a board that moved).

Useful commands:

```bash
pnpm quarry referrals fanout <jobId>     # draft referral asks for one job (default 10 people)
pnpm quarry referrals approve <jobId>    # approve the whole batch
pnpm quarry outreach send --live         # send one approved email (--watch to keep going)
pnpm quarry apply draft <jobId>          # map an application form and screenshot it filled
pnpm quarry apply send --live            # submit approved applications
pnpm quarry pipeline list                # where every job is in the state machine
pnpm quarry sweep                        # run the hourly pass now
```

The complete command reference is [docs/cli.md](docs/cli.md).

---

## The dashboard

`pnpm web:build && pnpm server` serves it at <http://localhost:3000> (`pnpm web:dev` for Vite with hot reload on
:5173).

| Tab | What it's for |
|---|---|
| **Jobs** | Ranked jobs with filters; a job page shows match reasoning, deadline estimate, resume + ATS score, referral batch, outreach and the apply panel. |
| **Review** | The approval queue: referral asks, emails, follow-ups, applications, and *attention* items. |
| **Applications** | Every job the sequencer took on, its state and full timeline. |
| **Companies** | Companies and their boards; recently discovered ones; tag or exclude. |
| **Contacts** | Import a spreadsheet or LinkedIn's `Connections.csv`; LinkedIn drafts to send by hand. |
| **Profile** | Facts, preferences, and the application answer bank. |
| **Resume / Resumes** | Edit resume blocks; the rendered library, benchmark scores, *Scrap & regenerate*. |
| **Health** | Orchestrator incidents, actions taken, LLM spend. |
| **Chat** | A Claude Code chat with all of Quarry's tools (minus approve) — e.g. "here's a link, tailor my resume and draft referrals". See [docs/chatbot.md](docs/chatbot.md). |

---

## Driving it from Claude Code

`.mcp.json` registers an MCP server (`apps/mcp`) that wraps the HTTP API, so a Claude Code session in this repo
can list jobs, add a job from a link, tailor, fan out referrals, edit drafts, check pipeline health and run the
orchestrator. It needs `pnpm server` running.

The `approve` tool is the only path to a side effect. **Never add `mcp__quarry__approve` to an allowlist** —
its permission prompt is your approval.

---

## Safety model

These rules are enforced in code, not just policy:

- **Approval gate.** Actors only run `execute()` with an `ApprovedDraft`, which the core mints from an approved
  `review_items` row. Plugins cannot construct one.
- **Dry run by default.** `MODE=dev` (the default) and no `--live` flag means actors log what they would do and
  return a synthetic result. Application dry runs fill the form and screenshot it but never press Submit.
- **Idempotency.** Every side effect has an idempotency key; a retried send or submission never repeats.
- **Throttles.** A person is never asked twice within 30 days across all jobs and channels; a job gets at most
  10 referral asks; Gmail sends stay under a sender limit with 4–11 min random spacing. Global daily and
  per-company caps exist but are off by default.
- **Scoped network access.** Each plugin declares the domains it may reach; requests go through a per-domain
  rate limiter, and careers-page crawling respects `robots.txt`.
- **No invented facts.** Resume bullets come from your fact bank; the skills rewrite and bullet shortening are
  checked against it. Application answers about salary, notice period, visa, work authorization and EEO are
  never generated — they come from `preferences.yaml` or stay blank for you.
- **LinkedIn is manual.** Referral fan-out drafts LinkedIn messages for you to send yourself. The older
  automation is dormant behind `LINKEDIN_ENABLED=true` + a live run on a dedicated account, and any checkpoint
  pauses it. See [docs/linkedin.md](docs/linkedin.md).
- **Secrets** live in `.env` or the OS keychain, are never logged, and never stored in the audit log.

More detail: [docs/safety.md](docs/safety.md).

---

## Repository layout

```
apps/
  server/      Fastify API + pg-boss workers; serves the dashboard
  web/         React dashboard (Vite → apps/web/dist)
  cli/         the `quarry` command
  mcp/         MCP server for Claude Code (stdio, wraps the HTTP API)
packages/
  core/        pipeline engine, plugin host, rate limiter, idempotency, sequencer, sweeper, ATS score
  db/          Drizzle schema, migrations, repositories
  plugin-sdk/  types + helpers for plugin authors (incl. the account wizard for Workday/SF/Taleo)
  plugins/     plugin registry
  llm/         LLM interface + Claude Code CLI and OpenRouter adapters
  embeddings/  local embedding service
  orchestrator/ health checks, experts, ops actions, gated code fixes
  shared/      zod schemas, config, logging, profile loading
plugins/       source-*, enricher-*, matcher-*, tailor-*, actor-*, tracker-*
profile/       facts.yaml, preferences.yaml, resume/ (your data; gitignored — copy profile.example/)
data/          seed CSVs; generated resumes, screenshots and session files (gitignored)
docs/          user and reference documentation
```

---

## Development

```bash
pnpm test          # unit + integration (fixtures only; *.db.test.ts need Postgres)
pnpm typecheck
pnpm lint
pnpm smoke:cli     # every read-only CLI command against your DB
pnpm smoke:api     # every API route against a running server
```

External HTTP is tested against recorded fixtures, never live endpoints. DB tests skip with a warning when
Postgres is down (`QUARRY_REQUIRE_DB=1` makes that a failure). See [docs/testing.md](docs/testing.md), and
[docs/plugins.md](docs/plugins.md) to write a new source, enricher or actor.

Design history and the reasoning behind each phase are in `PLAN.md`, `PLAN-phases-6-13.md`,
`PLAN-phases-15-23.md` and `CHANGELOG.md`.

---

## Documentation

| Doc | Covers |
|---|---|
| [Getting started](docs/getting-started.md) | Install, first run, connecting Gmail, turning on autopilot and live mode |
| [Architecture](docs/architecture.md) | Stages, event chain, data model, plugin host, where the LLM is used |
| [Configuration](docs/configuration.md) | Every `.env` variable and `config.yaml` key with defaults |
| [Profile](docs/profile.md) | `facts.yaml`, `preferences.yaml`, the `application` block, resume blocks |
| [Sources & discovery](docs/sources.md) | Supported ATSs, company CSV, alert emails, `discover_ats` / `discover_companies` |
| [Matching](docs/matching.md) | Filters, similarity prefilter, LLM rubric, keyword mode |
| [Resumes](docs/resumes.md) | Library, selector, ATS score, skills rewrite, one-page fit |
| [Outreach](docs/outreach.md) | Gmail, contacts, drafting, sending, replies and follow-ups |
| [LinkedIn](docs/linkedin.md) | Manual referral flow; the dormant automation |
| [Applications](docs/applications.md) | Auto-apply per ATS, answers, OTP, accounts, failures |
| [Autopilot](docs/autopilot.md) | Sequencer states, sweeper, deadlines, auto-approval |
| [Orchestrator](docs/orchestrator.md) | Health checks, incidents, experts, notifications |
| [Chatbot](docs/chatbot.md) | The dashboard Chat tab |
| [CLI reference](docs/cli.md) | Every `quarry` command |
| [Plugins](docs/plugins.md) | Writing a plugin: manifest, context, stage contracts |
| [Safety](docs/safety.md) | Guardrails and where they are enforced |
| [Testing](docs/testing.md) | Test layers and smoke scripts |
| [Troubleshooting](docs/troubleshooting.md) | Common errors and fixes |
