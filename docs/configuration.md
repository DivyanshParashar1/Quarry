# Configuration

Two files, both gitignored:

- **`.env`** — secrets, the database URL, the run mode and the LLM provider. Start from `.env.example`.
- **`config.yaml`** — everything else (routing, policies, schedules, plugin settings). Start from
  `config.example.yaml`. A missing file means all defaults; unknown keys are rejected with a clear error.

The schemas are `packages/shared/src/config.ts` (env) and `packages/shared/src/app-config.ts` (config.yaml).

## `.env`

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | Postgres URL; `.env.example` matches `docker-compose.yml` |
| `PORT` | `3000` | server port |
| `LOG_LEVEL` | `info` | pino level |
| `MODE` | `dev` | `dev` = every actor is a dry run; `live` = actors may act on **approved** items |
| `LLM_PROVIDER` | `claude-code` | `claude-code`, `openrouter`, `codex` or `antigravity` |
| `CLAUDE_CLI_PATH` | `claude` | path to the Claude Code CLI |
| `CLAUDE_DEFAULT_MODEL` | `claude-sonnet-4-6` | default model for the claude-code adapter |
| `CLAUDE_CONCURRENCY` / `CLAUDE_TIMEOUT_MS` | `2` / `120000` | parallel CLI calls / per-call timeout |
| `OPENROUTER_API_KEY` | — | required for `openrouter` |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | |
| `OPENROUTER_DEFAULT_MODEL` | `anthropic/claude-sonnet-4` | |
| `OPENROUTER_CONCURRENCY` / `OPENROUTER_TIMEOUT_MS` | `4` / `120000` | |
| `CODEX_CLI_PATH` / `CODEX_DEFAULT_MODEL` | `codex` / `default` | OpenAI Codex CLI; `default` = the model in `~/.codex/config.toml` |
| `CODEX_CONCURRENCY` / `CODEX_TIMEOUT_MS` | `2` / `180000` | |
| `ANTIGRAVITY_CLI_PATH` / `ANTIGRAVITY_DEFAULT_MODEL` | `agy` / `default` | Google Antigravity CLI; `agy models` lists slugs |
| `ANTIGRAVITY_CONCURRENCY` / `ANTIGRAVITY_TIMEOUT_MS` | `2` / `180000` | |
| `LATEX_BIN` | `latexmk` | LaTeX build command for resume PDFs |
| `BROWSER_EXECUTABLE_PATH` | Playwright's Chromium | use an installed Chrome instead |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | — | Desktop OAuth client ([outreach.md](outreach.md)) |
| `GMAIL_REDIRECT_URI` | `http://127.0.0.1:53682/oauth2callback` | |
| `GMAIL_REFRESH_TOKEN` | — | written by `quarry gmail auth` |
| `LINKEDIN_ENABLED` | `false` | enables the dormant LinkedIn automation ([linkedin.md](linkedin.md)) |
| `LINKEDIN_STATE_PATH` | `data/linkedin/state.enc` | encrypted LinkedIn session |
| `QUARRY_SESSION_KEY` | — | optional 32+ char key for session encryption (else OS keychain) |
| `NTFY_URL` | — | push notifications for incidents that need you (ntfy topic URL) |
| `BROWSER_HEADLESS` | `true` | `false` to watch Playwright runs |
| `QUARRY_REQUIRE_DB` | — | `1` = DB tests fail instead of skipping when Postgres is down |
| `QUARRY_API_URL` | `http://127.0.0.1:<PORT>` | where the MCP server finds the API (set in `.mcp.json`) |

### LLM provider

- **claude-code** needs the `claude` CLI installed and logged in; it uses your Claude subscription. Run
  `pnpm quarry llm check` to confirm.
- **openrouter** needs `OPENROUTER_API_KEY` and is billed per token.
- **codex** needs the OpenAI Codex CLI (`npm i -g @openai/codex`, then `codex login`).
- **antigravity** needs the Google Antigravity CLI (`agy`), logged in once interactively.

`.env.example` has a commented block per provider; uncomment only the one you use.

Per-task routing goes in `config.yaml`:

```yaml
llm:
  tasks:
    match:  { model: claude-haiku-4-5 }                          # cheap model for batched scoring
    tailor: { model: claude-sonnet-4-6 }
    # outreach: { provider: openrouter, model: google/gemini-2.5-flash }
```

Tasks: `match`, `tailor`, `outreach`, `extract`, `research` (deadlines, discovery), `orchestrator`.

## `config.yaml`

### `outreach`

| Key | Default | Meaning |
|---|---|---|
| `dailyCap` | `null` | optional cap on real emails per rolling 24 h (`null` = none) |
| `perCompanyPerWeek` | `null` | optional cap on distinct people per company per 7 days |
| `senderDailyLimit` | `400` | technical Gmail limit (consumer accounts allow ~500/day) |
| `perJobReferralCap` | `10` | referral asks per job |
| `perContactCooldownDays` | `30` | a person is never asked twice within this window, any job, any channel |
| `referralMinEmailConfidence` | `0.3` | below this, a contact with a LinkedIn profile is asked on LinkedIn instead |
| `spacingMinutes` | `[4, 11]` | random gap between real sends |
| `followupDays` | `[1]` | days to each follow-up (length caps the count) |
| `maxFollowups` | `1` | hard ceiling per thread |

### `autopilot`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | turns on the sweeper's LLM steps and the stage-to-stage event triggers |
| `strategy` | `referrals` | `referrals` (sequencer) or `single_email` (one email per job) |
| `minMatchScore` | `70` | jobs below this are ignored |
| `confidenceFloor` | match `0.75`, tailor `0.75`, outreach `0.8`, answers `0.85` | below any floor → waits for review |
| `minEmailConfidence` | `0.6` | min contact email confidence for auto-approval |
| `maxAutoApprovesPerDay` | `10` | auto-approvals per 24 h in the `single_email` strategy |
| `candidateBatch` | `20` | candidates walked per run |
| `referralWaitDays` | `2` | wait after the first ask before applying |
| `deadlineImminentDays` | `3` | apply immediately when the deadline is closer than this |
| `maxConcurrentJobs` | `50` | jobs in `referral_pending` at once |
| `referralsPerJob` | `null` | asks per job (`null` = `outreach.perJobReferralCap`) |
| `autoApproveReferrals` | `true` | auto-approve confident referral asks |
| `maxAutoApprovedAsksPerDay` | `200` | budget for auto-approved asks |
| `autoApproveApplications` | `false` | never auto-submit applications unless true |
| `maxPendingReviews` | `300` | backpressure: no new jobs/asks while this many items are pending (`null` = never pause) |

### `sweeper`

| Key | Default | Meaning |
|---|---|---|
| `intervalMinutes` | `60` | 60 or a divisor of 60 |
| `fetchEveryHours` | `6` | re-fetch boards older than this |
| `runOnStart` | `true` | catch up after downtime |
| `matchLimit` | `150` | max jobs LLM-scored per sweep |

### `resumes`

| Key | Default | Meaning |
|---|---|---|
| `projectsPerResume` | `3` | every combination of exactly this many projects is rendered |
| `selector.similarityWeight` | `0.4` | score = w·similarity + (1−w)·ATS |
| `selector.similarityLow` / `similarityHigh` | `0.5` / `0.9` | cosine mapped to 0 / 100 |
| `selector.threshold` | `75` | below → flagged "weak fit" (nothing blocked) |
| `selector.tieMargin` | `1` | near-ties broken by benchmark averages |
| `benchmarks.perCategory` | `5` | benchmark JDs auto-picked per category |
| `benchmarks.categories` | SWE intern, AI/ML engineer | seeded once; edit on the Resumes tab afterwards |

`resume.name`, `resume.contact`, `resume.headline` — header text for rendered resumes.

### `deadlines`

| Key | Default | Meaning |
|---|---|---|
| `minMatchScore` | `60` | only jobs at or above get an estimate |
| `staleDays` | `14` | re-estimate after |
| `batchSize` | `20` | estimates per run |
| `expireMinConfidence` / `expireGraceDays` | `0.6` / `1` | when a passed deadline closes a job |
| `nightly` | `false` | run estimates nightly on the server |

### `discovery`

| Key | Default | Meaning |
|---|---|---|
| `minConfidence` | `0.5` | detections below are reported, not saved |
| `lists.<id>` | all enabled | per list (`yc`, `gcc-journal`, `wellfound`, `internshala`, `hirect`): `enabled`, `urls`, `regions`, `maxNew` |
| `alertThreshold` | `40` | dashboard banner when one day adds more companies than this |
| `recheckDays` | `30` | re-detect each company's ATS this often |
| `nightly` | `true` | nightly discovery + recheck loops |

### `linkedin` (dormant automation only)

`dailyConnectionCap` 25 · `searchIntervalSeconds` 60 · `actionGapSeconds` [45, 120] · `cooldownMinutes` 60
(doubles each block) · `searchKeywords` · `profilesPerCompany` 15.

### `orchestrator`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | |
| `intervalMinutes` | `15` | |
| `dailyLlmBudgetUsd` | `5` | above it LLM steps pause until tomorrow (UTC) |
| `autoFix` / `maxCodeFixesPerDay` / `verifyWindowMin` | `true` / `3` / `60` | gated code-fix pipeline (not wired into the server; see [orchestrator.md](orchestrator.md)) |
| `checks.*` | see [orchestrator.md](orchestrator.md) | thresholds for the health checks |
| `codeFix.*` | `claude`, 30 min, setup + gates | how code fixes run |

### `chat`

`enabled` `true` · `model` · `timeoutMin` 30 · `maxConcurrent` 2 · `mergeCodeChanges` `true` · `setup` · `gates`.
See [chatbot.md](chatbot.md).

### `embeddings`

`model` (`Xenova/bge-small-en-v1.5`), `cacheDir`.

### `plugins.<pluginId>`

Each plugin validates its own section. Common ones:

```yaml
plugins:
  matcher-default:
    mode: llm              # llm | keywords
    minSimilarity: 0.55    # cosine floor before a job is worth an LLM call
    llmTopK: 150
    batchSize: 12
  tailor-resume-latex:
    fit: { minFontPt: 9, minLinespread: 0.94, maxShortenRounds: 2 }
  actor-apply-workday:
    tenants:               # per-tenant overrides (selectors, question maps)
      acme: { ... }
```

Relative `manifestPath` / `screenshotDir` values are resolved from the repo root.
