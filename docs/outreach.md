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
3. `pnpm jf gmail auth` and approve in the browser. Scopes: `gmail.send` and
   `gmail.readonly`. The refresh token is written to `.env` (mode 600) and never printed.
4. `pnpm jf gmail status` shows the connected address.

**"Error 403: access_denied … has not completed the Google verification process"**
means the account you signed in with is not on the app's test-user list. In
Google Cloud Console → **Google Auth Platform → Audience → Test users**, add that
exact Gmail address, then rerun `pnpm jf gmail auth`. Keep the app in *Testing*;
it does not need verification for your own use. (In Testing mode the refresh
token expires after 7 days; rerun `jf gmail auth` when it does.)

## 2. Contacts

```
pnpm jf contacts add --company "Acme" --domain acme.com --name "Jane Doe" --role "Engineering Manager"
pnpm jf contacts add --company "Acme" --name "Raj Patel" --email raj.patel@acme.com   # a known address
pnpm jf contacts enrich --company Acme     # infer missing emails from the pattern (MX-checked)
pnpm jf contacts list
```

Known addresses (`--email`, or a reply) teach the enricher the company's pattern
(`{first}.{last}`, `{f}{last}`, …). With none known it guesses from common patterns
and caps confidence at 40%. A bounce rules that pattern out. There is no SMTP probing.

## 3. Draft → review → approve

```
pnpm jf outreach draft --contact <id> --job <id>   # LLM draft into the review queue
pnpm jf review list
pnpm jf review edit <id> --subject "..." --body-file draft.txt
pnpm jf review approve <id>                         # the only path to a send
```

Or use the dashboard's **Review** tab (and the **Outreach** section on a job), or
the MCP tools from Claude Code (`approve` asks you to confirm).

## 4. Send

```
pnpm jf outreach send            # dry run: shows what would be sent
pnpm jf outreach send --live     # sends one approved email
pnpm jf outreach send --live --watch   # keeps going, respecting caps and spacing
```

With `MODE=live` the server's send loop does this every minute. Limits (in
`config.yaml` under `outreach:`):

| rule | default |
|---|---|
| real emails per rolling 24h (incl. follow-ups) | 20 |
| distinct people per company per 7 days | 2 (per-item override when approving) |
| random gap between sends | 4–11 minutes |
| follow-ups per thread | 2, after 5 then 7 days |

Each send has a Message-ID derived from its idempotency key; a retry first
searches Sent for it, so an email is never sent twice.

## 5. Replies, bounces, follow-ups

```
pnpm jf outreach track       # replies close the thread and cancel queued follow-ups; bounces mark the contact
pnpm jf outreach followups   # drafts due follow-ups into the review queue (you approve them like any email)
pnpm jf outreach threads
```

The server runs both automatically when Gmail is connected (tracking every 10
minutes, follow-up drafting hourly).

## Claude Code (MCP)

`.mcp.json` registers the `jobforge` MCP server; it needs `pnpm server` running.
Do not add `mcp__jobforge__approve` to an allowlist: its permission prompt (and
the confirmation dialog, where supported) is your approval.
