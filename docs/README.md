# Quarry documentation

Start with the [project README](../README.md) for what Quarry is and a quick start.

## Using Quarry

1. [Getting started](getting-started.md) — install, first run, Gmail, contacts, autopilot, live mode
2. [Profile](profile.md) — `facts.yaml`, `preferences.yaml`, the `application` block, resume blocks
3. [Sources & discovery](sources.md) — ATS boards, company CSV, alert emails, finding new companies
4. [Matching](matching.md) — how jobs are scored and how to tune it
5. [Resumes](resumes.md) — the library, per-job selection, ATS score, one-page fit
6. [Outreach](outreach.md) — Gmail, contacts, drafts, sending, replies and follow-ups
   - [Compose & Sent log](compose.md) — write a personal mail with two generated drafts, batch, schedule (Apps Script), and the log of every mail sent
7. [LinkedIn](linkedin.md) — the manual referral flow (and the dormant automation)
8. [Applications](applications.md) — auto-apply per ATS, answers, accounts, OTP
9. [Autopilot](autopilot.md) — the per-job state machine, sweeper, deadlines
10. [Orchestrator](orchestrator.md) — health checks, incidents, notifications
11. [Chatbot](chatbot.md) — the dashboard Chat tab

## Reference

- [Configuration](configuration.md) — every `.env` variable and `config.yaml` key
- [CLI reference](cli.md) — every `quarry` command
- [Architecture](architecture.md) — components, event chain, data model, LLM usage
- [Safety](safety.md) — guardrails and where they are enforced
- [Troubleshooting](troubleshooting.md)

## Development

- [Plugins](plugins.md) — writing a source, enricher, matcher, tailor, actor or tracker
- [Testing](testing.md) — test layers and smoke scripts
- Design history: `PLAN.md`, `PLAN-phases-6-13.md`, `PLAN-phases-15-23.md`, `CHANGELOG.md`
