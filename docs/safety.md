# Safety

Quarry acts on your behalf — your email, your LinkedIn identity, your job applications — so its guardrails are
enforced in code, and the code that enforces them is protected from automated changes.

## Guardrails

| Rule | Enforced by |
|---|---|
| **No side effect without an approved review item.** Actors' `execute()` takes an `ApprovedDraft` that only the core can mint from an approved `review_items` row. | `packages/core/src/outreach.ts`, `apply.ts` |
| **Dry run by default.** `MODE=dev` (default) or no `--live` → actors log and return a synthetic result; apply dry runs stop before Submit. | `packages/shared/src/config.ts`, plugin context |
| **Each side effect happens once.** Idempotency key unique in `actions`; Gmail sends carry a Message-ID derived from it and a retry checks Sent first. | `packages/core`, `actor-gmail-outreach` |
| **Plugins reach only their declared hosts**, through a per-domain token bucket with retries. | `ctx.http`, `rate-limiter.ts` |
| **`robots.txt` is respected** for careers-page crawling. | `packages/core/src/discovery/robots.ts` |
| **A person is never asked twice within 30 days**, across jobs and channels. | `outreach.perContactCooldownDays` |
| **A job gets at most its batch's referral cap** (10). | `outreach.perJobReferralCap` |
| **Sender technical limits**: Gmail `senderDailyLimit` (400) with 4–11 min spacing. Optional global daily and per-company caps are off by default. | `outreach.*` |
| **No invented facts.** Resume bullets come from your blocks; the skills rewrite and bullet shortening are checked against allowlists; LLM answers are grounded in your facts. | tailor validators, apply answer pipeline |
| **Never generated:** salary, notice period, visa/sponsorship, work authorization, EEO. | apply answer mapping |
| **Applications are not auto-approved** unless `autoApproveApplications: true`. Account terms are accepted only with `consent:terms` = Yes on the draft. | sequencer, `plugin-sdk/wizard.ts` |
| **LinkedIn outreach is manual.** Fan-out drafts; you send. The old automation needs `LINKEDIN_ENABLED=true` + live, on a dedicated account; any checkpoint, captcha or login wall pauses every LinkedIn loop with no retries. | `actor-linkedin-manual`, `packages/core/src/linkedin*.ts` |
| **Captchas and checkpoints are never solved** — anywhere. They raise an attention item. | all browser flows |
| **Secrets** stay in `.env` or the OS keychain, are never logged and never written to `events`. Per-tenant ATS passwords and the LinkedIn session key live in the keychain; the LinkedIn session file is AES-256-GCM encrypted, mode 600. | `session-store.ts`, `keychain.ts`, `credentials.ts` |
| **Audit log** — every executed action has an `events` entry. | `events` table |

## Agents and automated changes

- **MCP:** the `approve` tool is the only path to a side effect and must never be allowlisted in Claude Code;
  its permission prompt is your approval.
- **Chatbot:** runs without the `approve` tool, with network tools like curl blocked and history-changing git
  commands denied. Its code changes must pass protected-path checks, typecheck, lint and tests before merging
  ([chatbot.md](chatbot.md)).
- **Orchestrator:** ops actions only within bounded tools; it cannot approve, cannot solve captchas, and
  code-fix patches that touch a protected path are refused ([orchestrator.md](orchestrator.md)).
- **Protected paths** are listed in `packages/orchestrator/src/protected.ts`: approval gating, `MODE`/dryRun and
  env handling, rate limiter and caps, cooldowns, LinkedIn gate, session store and secrets, robots.txt, consent
  gating, plugin permissions, migrations, server approval routes, the MCP server, and the guardrails
  themselves.

## Your responsibilities

- Review what you approve. Auto-approval is limited to confident referral asks and follow-ups by default.
- Use a sending address you're comfortable sending volume from; consider a dedicated one.
- Keep `.env`, `config.yaml`, `profile/` and `data/` private. `.env`, `config.yaml`, `data/resumes/`,
  `data/linkedin/`, `data/screenshots/` and `data/apply-failures/` are gitignored.
- Respect each site's terms. The dormant LinkedIn automation violates LinkedIn's terms; it exists only for a
  dedicated account whose ban risk you accept.
