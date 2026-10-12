# CLI reference

Run as `pnpm quarry <command>` from anywhere in the repo (`.env` and `config.yaml` are found by walking up).
`pnpm quarry --help` prints the same list. Ids can be shortened to their first 8 characters.

Commands that could cause an external side effect are **dry runs** unless you pass `--live` (or set
`MODE=live`), and only ever act on approved review items.

## Companies and sources

| Command | Does |
|---|---|
| `companies import <file.csv> [--skip-invalid]` | Import companies + boards. Header: `name,ats_type,board_token[,domain,tags,location,notes,workday_tenant,workday_site,smartrecruiters_company_id]`. Idempotent. |
| `companies list` | List companies and boards. |
| `fetch [--plugin <id>] [--company <name>] [--concurrency <n>] [--no-alerts] [--verbose]` | Fetch every active board (or a subset), plus alert emails when Gmail is connected. |
| `gmail alerts [--since <ISO date>] [--dump <messageId>]` | Read job-alert emails only; `--dump` prints one message's HTML. |
| `gmail subscribe-template` | Print the alert searches to set up on each portal. |
| `discover_ats <domain\|name> [--name <company>] [--save] [--no-probe]` | Detect a company's ATS; `--save` writes it. |
| `discover_ats --missing [--limit <n>]` | Detect for companies with no board yet. |
| `discover_ats --recheck [--limit <n>]` | Re-detect companies not checked in `discovery.recheckDays`. |
| `discover_companies --list <yc\|gcc-journal\|wellfound\|internshala\|hirect> [--max-new <n>] [--dry-run] [--concurrency <n>]` | Crawl a company list. |
| `discover_companies --all` | Every enabled list (the nightly job). |

## Jobs, profile, matching

| Command | Does |
|---|---|
| `jobs list [--company <name>] [--q <text>] [--limit <n>] [--all]` | Jobs, sorted by score once matched; `--all` includes closed. |
| `profile load [--dir <dir>]` | Validate and activate `facts.yaml` + `preferences.yaml`. |
| `profile show` | Print the active profile. |
| `embed` | Embed new/changed jobs, facts and the profile (local model). |
| `match [--rescore] [--limit <n>] [--no-embed]` | Score open jobs. |
| `llm check` | Provider/model per task; reachability check (no model call). |
| `deadlines [--job <id>] [--limit <n>] [--rescore]` | Estimate application close dates (LLM + web search). |

## Resumes

| Command | Does |
|---|---|
| `resumes generate [--retire]` | Render the library (project combos + base resumes); `--retire` scraps and regenerates. |
| `resumes list [--all]` | Library with benchmark averages. |
| `resumes bench [--pick]` | ATS-score the library against benchmark JDs; `--pick` re-picks the JDs. |
| `tailor <jobId> [--force]` | Pick the best resume for a job + skills rewrite. Needs `latexmk`. |

## Contacts and outreach

| Command | Does |
|---|---|
| `gmail auth` / `gmail status` | Connect Gmail (local OAuth) / show the connected address. |
| `contacts add --company <name> --name <full name> [--role] [--email] [--linkedin] [--domain]` | Add one contact. |
| `contacts import <file.xlsx\|file.csv> [--yes]` | Import a sheet or LinkedIn `Connections.csv`; preview first, `--yes` writes. |
| `contacts list [--company <name>]` | List contacts. |
| `contacts enrich [--company <name>]` | Infer missing emails from the company pattern (MX-checked). |
| `outreach draft --contact <id> [--job <id>] [--force]` | LLM-draft an email into the review queue. |
| `outreach send [--live] [--watch]` | Send approved emails (one per run; `--watch` keeps going with spacing). |
| `outreach followups` | Draft due follow-ups for review. |
| `outreach track` | Check Gmail for replies and bounces. |
| `outreach threads` | List sent threads and their state. |

## Review

| Command | Does |
|---|---|
| `review list [--all]` | Pending items (`--all`: every state). |
| `review show <id>` | One item in full. |
| `review edit <id> [--subject] [--to] [--body-file <path>]` | Edit a draft. |
| `review approve <id> [--override-company-cap]` | Approve — the only path to a side effect. |
| `review reject <id> [--reason <text>]` | Reject. |

## Referrals and LinkedIn (manual)

| Command | Does |
|---|---|
| `referrals fanout <jobId> [--count <n>] [--live]` | Draft N referral asks to distinct people at the company. |
| `referrals show <jobId>` | Batch status: each ask, channel, send/reply state. |
| `referrals approve <jobId>` | Approve every pending ask in the batch. |
| `linkedin drafts [--job <id>]` | LinkedIn messages/notes to send by hand. |
| `linkedin sent <id>` / `accepted <id>` / `replied <id>` | Record that you sent it / they accepted your note (drafts the full message) / they replied. |

## Applications

| Command | Does |
|---|---|
| `apply draft <jobId> [--no-preview]` | Map the form and screenshot it filled (never submits). |
| `apply send [--live] [--watch]` | Submit approved applications. |
| `answers [list]` / `answers delete <id>` | The approved-answer bank. |

## Autopilot and operations

| Command | Does |
|---|---|
| `autopilot [--limit <n>] [--live]` | One sequencer tick. |
| `pipeline list [--state s1,s2] [--company <name>]` | Jobs in the state machine. |
| `pipeline show <jobId>` | A job's timeline. |
| `pipeline advance <jobId> [--live]` | Push a job one step. |
| `pipeline expire <jobId> --reason <text>` | Give up on a job. |
| `sweep [--live]` | One sweeper pass now. |
| `orchestrator run` | One orchestrator pass (ops actions only). |
| `incidents [--all]` | Open (or all) incidents. |

## LinkedIn automation (dormant)

Needs `LINKEDIN_ENABLED=true` and `--live`, on a dedicated account. Fan-out never uses it. See [linkedin.md](linkedin.md).

| Command | Does |
|---|---|
| `linkedin login` / `status` / `resume` | Save the session (headed browser, encrypted) / health / clear a pause. |
| `linkedin employees --company <name> [--limit <n>] [--live]` | Search a company's engineers. |
| `linkedin send [--live] [--watch]` | Send approved LinkedIn asks. |
| `linkedin track [--live]` | Accepted connections and replies. |

## Workspace scripts

| Script | Does |
|---|---|
| `pnpm server` | API, dashboard and background loops on :3000 |
| `pnpm web:build` / `pnpm web:dev` | Build the dashboard / Vite dev server on :5173 |
| `pnpm db:migrate` / `db:generate` / `db:studio` | Migrations / new migration from schema / Drizzle Studio |
| `pnpm test` / `typecheck` / `lint` / `format` | Checks |
| `pnpm smoke:cli [--network]` / `smoke:api [--base URL] [--no-ops]` | Smoke tests ([testing.md](testing.md)) |
| `pnpm live:sources [--save dir]` | Read-only check of every source against a real board |
| `pnpm --filter @quarry/llm smoke -- --provider claude-code\|openrouter` | Real-provider LLM smoke test (costs money) |
