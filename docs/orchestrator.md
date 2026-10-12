# Orchestrator

The orchestrator watches the whole system and fixes what it safely can. The server runs a pass every
`orchestrator.intervalMinutes` (15) and whenever a stage emits a failure event.

```bash
pnpm quarry orchestrator run     # one pass now
pnpm quarry incidents [--all]    # open (and with --all, resolved) incidents
```

Dashboard: **Health** tab — open incidents, actions taken, LLM spend.

## 1. Health checks (deterministic)

| Check | Threshold (`orchestrator.checks`) |
|---|---|
| A board fails repeatedly | `sourceErrorStreak` (3) consecutive failed fetches |
| An apply actor fails | `applyFailures` (2) failed/unrecognised applications in 24 h |
| A job is stuck | `stuckHours.referral_pending` (96), `stuckHours.ready_to_apply` (48) |
| Review backlog | `reviewBacklog` (300) pending items |
| Bounce rate | `bounceRate` (0.15) over 7 days, with at least `minSends` (10) sends |
| Stage failures | `stageFailures` (5) errors of one kind in 24 h (resume fit, tailoring) |
| LLM budget | spend today (UTC) above `dailyLlmBudgetUsd` ($5) |

Each failed check opens (or updates) an **incident**.

## 2. Experts

The incident is routed to one expert, which returns a diagnosis and a plan of actions from its own narrow
toolset:

| Expert | Handles | Allowed actions |
|---|---|---|
| Sources | failing, drifting or empty boards | requeue / pause / resume a board, pause a plugin, raise attention |
| Apply | form failures, selector drift, unknown pages | pause/resume a plugin, set a tenant override, raise attention |
| Outreach | bounces, deliverability | pause/resume a plugin, raise attention |
| Resume | fit overflow, low ATS scores, tailoring errors | rerun a stage, raise attention |
| Ops | stuck jobs, queues, budget, backlog | advance / expire a job, top up a referral batch, rerun a stage, pause LLM steps, pause/resume a plugin, raise attention |

Common cases have a deterministic plan (a board returning 404/410 is paused; a spent budget pauses LLM steps
until midnight UTC; too many bounces pause email outreach for 24 h); others go to the LLM.

## 3. What it never does

- Solve a captcha, checkpoint or login wall — it pauses and notifies.
- Approve anything or bypass a review item.
- Touch protected paths (approval gating, `MODE`/dryRun, rate limits and caps, cooldowns, LinkedIn gate,
  secrets, robots.txt, consent, its own guardrails) — see `packages/orchestrator/src/protected.ts`.

## Code fixes

`packages/orchestrator` contains a gated code-fix pipeline: Claude Code in a git worktree reproduces the failure
with a fixture, patches it, and must pass `pnpm typecheck`, `pnpm lint` and `pnpm test` with protected paths
refused; a merged fix is watched for `verifyWindowMin` and reverted on regression. **The running server does not
launch it**: it runs ops actions only and escalates code-fix proposals to you as attention items.

## Notifications

Problems only you can fix (an expired Gmail token, a captcha, a spent budget) become **attention** items in the
Review tab. Set `NTFY_URL` in `.env` (e.g. `https://ntfy.sh/<secret-topic>`) to also get a push notification.
Resolve an incident from the Health tab or the MCP `resolve_incident` tool.
