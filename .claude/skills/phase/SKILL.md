---
name: phase
description: Work on a single PLAN.md phase end-to-end. Use when the user says "start Phase N", "finish the phase", or asks to resume work on JobForge. Enforces the one-phase-at-a-time rule and the stop-at-end-of-phase handoff.
---

# phase

JobForge is built in discrete phases defined in `PLAN.md` section 8. This skill runs one phase properly.

## When invoked

1. Read `PLAN.md` (all of it, not just section 8) and `CHANGELOG.md`. The current phase is the first one in section 8 whose work isn't reflected in CHANGELOG.
2. Read `CLAUDE.md` for the working rules — those are binding, not advisory.
3. State the phase goal and the "Done when" criterion back to the user in one or two sentences before touching code.

## While working

- Do **only** work in the current phase. If something belongs to a later phase, note it as a gap and move on.
- No dependency outside PLAN.md section 2 without flagging the add and the reason.
- Write tests alongside code. External HTTP → recorded fixtures, never live endpoints in CI.
- When an external API shape is uncertain, fetch and inspect it once, save a fixture, then code against the fixture.
- Never send real email, submit forms, or call paid APIs without explicit user approval in the session.
- Keep commits small and focused. Match the project's existing commit style (`git log` to check).

## At phase end (the handoff)

Run in order:

1. `pnpm -r typecheck`
2. `pnpm lint`
3. `pnpm test`

All three must pass before continuing. If anything fails, fix it — don't ship a red phase.

Then:

4. Append a new `## [Phase N] — <name>` section to `CHANGELOG.md` listing what was built.
5. Write the phase summary message to the user with four parts:
   - **Built** (bullet list with file links)
   - **Dependencies added** (confirm all are in PLAN.md §2, or flag any that aren't)
   - **Known gaps / deferred**
   - **Decisions made without asking** (so the user can override)
6. **Stop.** Do not start the next phase without explicit go-ahead.

## Common commands

- `pnpm db:generate` — generate Drizzle migration from schema changes
- `pnpm db:migrate` — apply migrations (requires `docker compose up -d` first)
- `pnpm --filter @jobforge/<pkg> <script>` — run a workspace script