# The JobForge chatbot

Dashboard → **Chat** (or `POST /api/chat/sessions` + `/messages`). Each message runs the Claude Code CLI you are
logged into (`CLAUDE_CLI_PATH`, uses your Claude usage) in the chat's own git worktree of `main`
(`~/.jobforge/chat/<session>`), resuming the same Claude conversation each time.

What it can do
- The whole product through the JobForge MCP tools (jobs, `add_job` from any link, tailoring, referral asks, outreach
  and application drafts, contacts, discovery, pipeline, health/incidents, the orchestrator).
- The web (WebSearch / WebFetch) — e.g. "here's a link, tailor my resume and draft referrals": it fetches the JD,
  adds the job, tailors, fans out referral drafts.
- Read and change the code, and run shell commands / its own scripts (any command, compound commands included;
  scratch files in `.chat-scratch/`) — except a deny list: curl/wget/nc/ssh/scp, git commands that change history,
  sudo, `rm -rf`, chmod/chown, the macOS keychain (`security`), launchctl, crontab.

What it can't do
- Approve, send, submit or publish: the MCP `approve` tool is withheld, curl/wget are blocked, and its instructions
  forbid it. Drafts wait for you in **Review**. (This is enforced by tool permissions, not by the API itself.)
- Change history (commit/reset/checkout/merge/push are blocked) or touch protected safety files.

Code changes
After each message, whatever it changed is checked like an orchestrator fix: protected paths refused
(`packages/orchestrator/src/protected.ts`), then `pnpm typecheck`, `pnpm lint`, `pnpm test` (a failing gate is run once more before the change is refused; the full output is kept in the chat's
`.chat-scratch/gate-*.log`); if all pass it is
committed ("chat: <your request>", no AI trailer) and merged into a clean `main`. Otherwise it is kept on a
`chat/<id>-parked-*` branch and the chat tells you why. Restart the server to load server-side changes.
`chat.mergeCodeChanges: false` in config.yaml keeps every change on a branch instead.

Config (`config.yaml` → `chat`): `enabled`, `model`, `timeoutMin` (30), `maxConcurrent` (2), `mergeCodeChanges`,
`setup` (run once per new chat worktree), `gates`.
