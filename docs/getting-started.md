# Getting started

This walks a fresh clone from nothing to a running dashboard, then through the optional pieces (Gmail,
contacts, autopilot, live mode) in the order you'll want them.

## 1. Install

Prerequisites: Node ≥ 22, pnpm (`corepack enable`), Docker, TeX Live with `latexmk`, and either the
[Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (logged in) or an OpenRouter API key.

```bash
pnpm i
pnpm exec playwright install chromium     # needed for application form-fill and previews
cp .env.example .env
cp config.example.yaml config.yaml
docker compose up -d                      # Postgres 16 + pgvector on :5432 (data in ./pgdata)
pnpm db:migrate
```

`.env` holds secrets and the run mode; `config.yaml` holds everything else. Both are gitignored. Every key is
described in [configuration.md](configuration.md).

Check the LLM provider:

```bash
pnpm quarry llm check
```

It prints the provider and model for each task and checks the provider is reachable without spending a call.

## 2. Your profile

Quarry never invents anything about you, so it needs three things in `profile/` ([profile.md](profile.md) has
the full format):

1. **`facts.yaml`** — experience, projects, education, skills and achievements as small factual entries with
   stable ids.
2. **`preferences.yaml`** — target roles, seniority, locations, remote policy, stack, graduation year,
   experience, keyword gates and exclusions (used by the matcher), and the `application` block (name, email,
   phone, links, work authorization, EEO answers) used to fill forms.
3. **`resume/`** — your resume split into LaTeX blocks: `preamble.tex`, `blocks/*.tex` (one per education entry,
   job, project, skills section…) and `manifest.yaml` describing them.

Then:

```bash
pnpm quarry profile load     # validates and activates it; re-run after every edit
pnpm quarry profile show
```

Also set your name, contact line and headline under `resume:` in `config.yaml` if your header block uses them.

## 3. Companies and jobs

```bash
pnpm quarry companies import data/companies.seed.csv
pnpm quarry fetch
pnpm quarry jobs list
```

The CSV header is `name,ats_type,board_token[,domain,tags,location,notes,workday_tenant,workday_site,smartrecruiters_company_id]`.
Re-importing is idempotent and a failing board never stops the others. To grow the list:

```bash
pnpm quarry discover_ats stripe.com --save            # detect one company's ATS
pnpm quarry discover_companies --list yc --dry-run    # preview a crawled list
pnpm quarry discover_companies --list yc
```

See [sources.md](sources.md).

## 4. Match

```bash
pnpm quarry embed     # first run downloads the local embedding model
pnpm quarry match
pnpm quarry jobs list
```

Hard filters run first and cost nothing; only survivors that clear the similarity floor reach the LLM, in
batches. `quarry match` skips jobs it has already scored; `--rescore` redoes them after you change preferences.
For a zero-LLM run set `plugins.matcher-default.mode: keywords`. See [matching.md](matching.md).

## 5. Resumes

```bash
pnpm quarry resumes generate        # renders every combination of N projects (default 3), one page each
pnpm quarry resumes list
pnpm quarry tailor <jobId>          # pick the best one for a job + skills-only rewrite
```

PDFs land in `data/resumes/`. See [resumes.md](resumes.md).

## 6. Dashboard

```bash
pnpm web:build
pnpm server
```

Open <http://localhost:3000>. The server also starts its background loops: alert emails every 30 minutes, the
sweeper on start and hourly (re-fetching boards older than 6 h), nightly company discovery, reply tracking,
and the orchestrator every 15 minutes.

## 7. Gmail (optional, needed for outreach, alert emails and OTP codes)

Create a Desktop OAuth client in Google Cloud, put the id/secret in `.env`, then:

```bash
pnpm quarry gmail auth
pnpm quarry gmail status
```

Full steps and the common `403 access_denied` fix are in [outreach.md](outreach.md#1-connect-gmail-once).
Once connected, `quarry fetch` also reads job-alert emails; `pnpm quarry gmail subscribe-template` prints the
alert searches to set up on each portal.

## 8. Contacts (for referrals)

Export your LinkedIn connections (LinkedIn → Settings → Data privacy → *Get a copy of your data* →
Connections) and import the file, plus any spreadsheet of people you know:

```bash
pnpm quarry contacts import Connections.csv           # shows an EDA report and the column mapping
pnpm quarry contacts import Connections.csv --yes     # writes it
```

Or use the Contacts tab → Upload. Imported people are asked first when a job is fanned out. See
[linkedin.md](linkedin.md) and [outreach.md](outreach.md).

## 9. Try one job by hand

```bash
pnpm quarry referrals fanout <jobId>       # drafts up to 10 asks
pnpm quarry referrals show <jobId>
pnpm quarry review list
pnpm quarry referrals approve <jobId>
pnpm quarry outreach send                  # dry run: prints what would go out
pnpm quarry apply draft <jobId>            # maps the form, screenshots it filled, never submits
```

Nothing has left your machine yet.

## 10. Turn on autopilot

In `config.yaml`:

```yaml
autopilot:
  enabled: true
```

The sweeper then also matches new jobs, picks resumes, fans out referrals, drafts the 24 h follow-up and
queues applications when a job is ready. Confident drafts are auto-approved within daily budgets; everything
else waits in Review. Applications are **never** auto-approved unless you set
`autopilot.autoApproveApplications: true`. See [autopilot.md](autopilot.md).

## 11. Go live

Everything above is a dry run. To actually send and submit, set in `.env`:

```
MODE=live
```

and restart the server, or pass `--live` to a single CLI command. Live mode still only acts on **approved**
review items. Start with one email and one application, watch the result, then leave it running.

## Next

- [Daily use](../README.md#daily-use)
- [Troubleshooting](troubleshooting.md)
