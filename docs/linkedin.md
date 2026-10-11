# LinkedIn referrals

## Since Phase 17: manual, by default and in fan-out

Referral fan-out **never automates LinkedIn**. Nothing logs into your account.

1. Export your connections: LinkedIn → Settings → Data privacy → *Get a copy of your data* →
   **Connections**. You get `Connections.csv` by email.
2. Import it (Contacts tab → Upload, or `pnpm jf contacts import Connections.csv --yes`). Everyone
   in it is recorded as a 1st-degree connection. Hand-made `.xlsx`/`.csv` lists import the same way.
3. When a job is fanned out (`jf referrals fanout <jobId>` or the job page), imported people are
   asked first:
   - a **connection** at the company gets a full tailored message (role, job link, one resume
     bullet, "resume attached");
   - someone with a LinkedIn profile but no usable email gets a **connection-request note**
     (≤ 300 characters);
   - everyone else gets an email as before.
4. You send them yourself: the dashboard (Contacts tab, job page, review queue) has **Copy text**,
   **Open profile**, **Download resume PDF**, then **I sent it** — or `jf linkedin drafts`,
   `jf linkedin sent <id>`. When they answer, **They replied** / `jf linkedin replied <id>`.
   Marking sent keeps the 30-day per-person cooldown, the job's referral batch and the
   apply-after-reply timing correct.

The official LinkedIn API can't read your connections (closed to non-partners since 2015),
which is why the export is used.

## The older automation (Phases 8–9; dormant)

LinkedIn automation is **off by default** and runs only on a **dedicated LinkedIn
account** you create for this. LinkedIn's terms forbid automation; the ban risk is
accepted and isolated to that account. Never point this at your main profile.

## Setup

1. Create the dedicated account and fill in a credible profile (photo, headline,
   education) — empty profiles get restricted quickly.
2. In `.env`:
   ```
   LINKEDIN_ENABLED=true
   # optional: a 32+ char key; otherwise the OS keychain (macOS `security`,
   # Linux `secret-tool`) or ~/.config/jobforge/linkedin-session.key is used
   # JOBFORGE_SESSION_KEY=...
   ```
3. Log in once (opens a real browser window):
   ```
   pnpm jf linkedin login
   ```
   The session is saved AES-256-GCM encrypted to `data/linkedin/state.enc`
   (mode 600). Later runs are headless (`BROWSER_HEADLESS=false` to watch).
4. Check: `pnpm jf linkedin status`.

Everything that touches LinkedIn also needs a **live** run: `--live` on the CLI
or `MODE=live` for the server loops. Without it you get dry-run previews.

## Flow

```
jf referrals fanout <jobId> [--count 10] [--live]   # drafts N asks; with --live, searches LinkedIn for more engineers first
jf referrals show <jobId>                          # or the Referrals panel on the job page
jf referrals approve <jobId>                       # one click: approve the whole batch
jf outreach send --live                            # email asks
jf linkedin send --live --watch                    # LinkedIn asks: connection request + ≤300-char note
jf linkedin track --live                           # accepted connections / replies → batch "replied"
```

The server runs `linkedin.send` every minute and `linkedin.track` every 30
minutes when `LINKEDIN_ENABLED=true` and `MODE=live`.

## Safeguards (technical, not product caps)

- `linkedin.dailyConnectionCap` (25/day) — LinkedIn's soft limit for new accounts.
- 45–120 s random gaps between requests (`linkedin.actionGapSeconds`), human-ish
  mouse movement and typing, one people search per 60 s.
- Any checkpoint, captcha, login wall, "restricted" or weekly-limit page **pauses
  every LinkedIn loop** and raises an *attention* item in the review queue. No
  retries. Fix it by hand in the dedicated account (or `jf linkedin login` if the
  session expired), then approve the attention item ("Fixed — resume") or run
  `jf linkedin resume`. Each block doubles the next cool-down.
- A profile that already shows *Pending* or *1st* is never sent a second request.
- Pre/post screenshots of every request land in `data/screenshots/linkedin/`.

## Product rules that also apply to LinkedIn

- A person is asked at most once per `outreach.perContactCooldownDays` (30) across
  all jobs and channels.
- A job gets at most its batch's referral count (default `outreach.perJobReferralCap` = 10).
- An accepted connection or a reply marks the job's batch *replied* and stops its
  email follow-ups; the autopilot (Phase 12) moves on to applying.
