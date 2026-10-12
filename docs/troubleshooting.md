# Troubleshooting

## Setup

**`pnpm db:migrate` / DB tests can't connect.** Postgres isn't up: `docker compose up -d`, then
`docker compose ps` until it's healthy. `DATABASE_URL` in `.env` must match `docker-compose.yml`. DB tests skip
with a warning when Postgres is down; `QUARRY_REQUIRE_DB=1` makes that a failure.

**"too many clients" during tests.** The compose file sets `max_connections=100`; recreate the container if you
started it from an older compose file.

**`quarry llm check` fails with claude-code.** The `claude` CLI must be on `PATH` (or set `CLAUDE_CLI_PATH`) and
logged in — run `claude` once interactively. With OpenRouter, check `OPENROUTER_API_KEY`.

**`latexmk: command not found` on `tailor` / `resumes generate`.** Install TeX Live (`brew install --cask
mactex-no-gui` or `apt install texlive-full latexmk`) and open a new shell.

**Playwright: "Executable doesn't exist".** `pnpm exec playwright install chromium`.

**Config error on startup.** `config.yaml` is strictly validated; the error names the bad key path. Compare with
`config.example.yaml` and [configuration.md](configuration.md).

## Jobs and matching

**`quarry fetch` finds nothing for a company.** Check its board with `quarry companies list`; re-detect with
`quarry discover_ats <domain> --save`. A board that errors three times in a row is paused by the orchestrator —
see the Health tab.

**Every job scores 0.** Open a job: the reason names the hard filter. Common causes: `seniority` (a title with no
level counts as *mid*), `locations`, `graduation_year`, or `keywords.title_any`. Fix `preferences.yaml`, then
`quarry profile load && quarry match --rescore`.

**Match is slow or expensive.** Lower `plugins.matcher-default.llmTopK`, raise `minSimilarity`, route `match` to
a cheaper model, or use `mode: keywords`.

## Resumes

**Variant marked `overflow`.** The resume didn't fit one page even after font, spacing and shortening. Trim a
block, lower `projectsPerResume`, or relax `fit.minFontPt` / `minLinespread`.

**ATS score is low with "text not extractable" or ligature warnings.** Check your `preamble.tex`: use
`\pdfgentounicode=1` / `glyphtounicode`, avoid text in images, tables or multi-column layouts.

## Gmail and outreach

**`Error 403: access_denied … has not completed the Google verification process`.** Add your Gmail address under
Google Auth Platform → Audience → Test users, then rerun `quarry gmail auth`.

**Sends stopped after a week.** In *Testing* mode Google refresh tokens expire after 7 days; rerun
`quarry gmail auth`.

**Nothing is being sent.** Check, in order: is the item approved (`quarry review list --all`)? Is `MODE=live`
(or did you pass `--live`)? Is the server running? Is the contact inside the 30-day cooldown? Is
`actor-gmail-outreach` paused by the orchestrator after bounces (Health tab)?

**Autopilot does nothing.** `autopilot.enabled` must be `true`; jobs need score ≥ `minMatchScore`; backpressure
pauses new jobs when `maxPendingReviews` items are pending; LLM steps pause when `dailyLlmBudgetUsd` is spent.

## Applications

**Application fails with an attention item.** Look at the screenshots on the item and in `data/apply-failures/`.
Unknown layouts are never guessed. Add a tenant override under `plugins.<actor>.tenants`, or apply by hand and
`quarry pipeline advance <jobId>`.

**Workday/SF/Taleo stuck on verification.** The code is read from Gmail; Gmail must be connected with read scope
and the account email must be that Gmail address. No code in 5 minutes → attention item.

## LinkedIn (dormant automation)

**Everything LinkedIn is paused.** A checkpoint, captcha or login wall was hit. Fix it by hand in the dedicated
account (or `quarry linkedin login`), then approve the attention item or run `quarry linkedin resume`.

## Dashboard

**Blank page.** Rebuild: `pnpm web:build`, restart `pnpm server`. During development use `pnpm web:dev`.

**API returns 403 from a script.** State-changing requests need the `x-quarry` header and a same-origin request
(CSRF guard).

**MCP tools fail in Claude Code.** The MCP server needs `pnpm server` running on `http://127.0.0.1:3000`.
