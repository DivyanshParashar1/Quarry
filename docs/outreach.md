# Outreach (Phase 3)

Nothing leaves your machine without an **approved review item**. Sending is a
**dry run** unless you pass `--live` or set `MODE=live`.

## 1. Connect Gmail (once)

1. In Google Cloud Console: create a project, enable the **Gmail API**, configure
   the OAuth consent screen (External, add yourself as a test user), and create an
   OAuth client of type **Desktop app**.
2. Put the client id/secret in `.env`:
   ```
   GMAIL_CLIENT_ID=...
   GMAIL_CLIENT_SECRET=...
   GMAIL_REDIRECT_URI=http://127.0.0.1:53682/oauth2callback
   ```
3. `pnpm quarry gmail auth` and approve in the browser. Scopes: `gmail.send` and
   `gmail.readonly`. The refresh token is written to `.env` (mode 600) and never printed.
4. `pnpm quarry gmail status` shows the connected address.

**"Error 403: access_denied … has not completed the Google verification process"**
means the account you signed in with is not on the app's test-user list. In
Google Cloud Console → **Google Auth Platform → Audience → Test users**, add that
exact Gmail address, then rerun `pnpm quarry gmail auth`. Keep the app in *Testing*;
it does not need verification for your own use. (In Testing mode the refresh
token expires after 7 days; rerun `quarry gmail auth` when it does.)

## 2. Contacts

```
pnpm quarry contacts add --company "Acme" --domain acme.com --name "Jane Doe" --role "Engineering Manager"
pnpm quarry contacts add --company "Acme" --name "Raj Patel" --email raj.patel@acme.com   # a known address
pnpm quarry contacts enrich --company Acme     # infer missing emails from the pattern (MX-checked)
pnpm quarry contacts list
```

Known addresses (`--email`, or a reply) teach the enricher the company's pattern
(`{first}.{last}`, `{f}{last}`, …). With none known it guesses from common patterns
and caps confidence at 40%. A bounce rules that pattern out. There is no SMTP probing.

## 3. Draft → review → approve

```
pnpm quarry outreach draft --contact <id> --job <id>   # LLM draft into the review queue
pnpm quarry review list
pnpm quarry review edit <id> --subject "..." --body-file draft.txt
pnpm quarry review approve <id>                         # the only path to a send
```

Or use the dashboard's **Review** tab (and the **Outreach** section on a job), or
the MCP tools from Claude Code (`approve` asks you to confirm).

## 4. Send

```
pnpm quarry outreach send            # dry run: shows what would be sent
pnpm quarry outreach send --live     # sends one approved email
pnpm quarry outreach send --live --watch   # keeps going, respecting caps and spacing
```

With `MODE=live` the server's send loop does this every minute. Limits (in
`config.yaml` under `outreach:`):

| rule | default |
|---|---|
| a person is asked at most once per | 30 days, any job or channel (`perContactCooldownDays`) |
| referral asks per job | 10 (`perJobReferralCap`) |
| Gmail sender limit (technical) | 400 per rolling 24 h (`senderDailyLimit`) |
| random gap between sends | 4–11 minutes (`spacingMinutes`) |
| follow-ups per thread | 1, after 24 h (`followupDays` / `maxFollowups`) |
| real emails per rolling 24 h | no cap (opt in with `dailyCap`) |
| distinct people per company per 7 days | no cap (opt in with `perCompanyPerWeek`; `--override-company-cap` when approving) |

Each send has a Message-ID derived from its idempotency key; a retry first
searches Sent for it, so an email is never sent twice.

## 5. Replies, bounces, follow-ups

```
pnpm quarry outreach track       # replies close the thread and cancel queued follow-ups; bounces mark the contact
pnpm quarry outreach followups   # drafts due follow-ups into the review queue (you approve them like any email)
pnpm quarry sweep                # the server's hourly pass: alerts, tracking, and (autopilot on) the 24 h follow-up,
                             # auto-approved when the draft is confident; LinkedIn follow-ups are drafted for you to send
pnpm quarry outreach threads
```

The server tracks replies every 10 minutes when Gmail is connected; since Phase 18
follow-up drafting is part of the hourly sweeper and runs only with `autopilot.enabled: true`.

## Claude Code (MCP)

`.mcp.json` registers the `quarry` MCP server; it needs `pnpm server` running.
Do not add `mcp__quarry__approve` to an allowlist: its permission prompt (and
the confirmation dialog, where supported) is your approval.
