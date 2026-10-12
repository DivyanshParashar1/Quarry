# Sources and company discovery

Quarry's coverage comes from two places: **public ATS job boards** of companies it knows about, and
**job-alert emails** in your Gmail for portals it does not scrape (LinkedIn, Naukri, …).

## Supported ATSs

| ATS | Plugin | Board identifier | Apply plugin |
|---|---|---|---|
| Greenhouse | `source-greenhouse` | board token (`boards.greenhouse.io/<token>`) | `actor-apply-greenhouse` |
| Lever | `source-lever` | company slug (`jobs.lever.co/<slug>`) | `actor-apply-lever` |
| Ashby | `source-ashby` | org slug (`jobs.ashbyhq.com/<slug>`) | `actor-apply-ashby` |
| SmartRecruiters | `source-smartrecruiters` | company id | `actor-apply-smartrecruiters` |
| Workday | `source-workday` | tenant + site (`<tenant>.wd<N>.myworkdayjobs.com/<site>`) | `actor-apply-workday` |
| SuccessFactors | `source-successfactors` | tenant | `actor-apply-successfactors` |
| Taleo | `source-taleo` | tenant (`<tenant>.taleo.net`) | `actor-apply-taleo` |

Each source declares the hosts it may reach and a per-domain rate limit (Workday and SuccessFactors: about
1 request/second per tenant). A failing board is recorded and skipped; it never stops the rest.

## Adding companies

### From a CSV

```bash
pnpm quarry companies import data/companies.seed.csv [--skip-invalid]
pnpm quarry companies list
```

Header: `name,ats_type,board_token,tags,domain,location,notes,workday_tenant,workday_site,smartrecruiters_company_id`.
`tags` are `;`-separated (`startup;fintech`). Re-importing is idempotent. A row with only a `domain` is fine:
`quarry discover_ats --missing` fills in the ATS later.

### Detecting a company's ATS

```bash
pnpm quarry discover_ats stripe.com                # print what it finds
pnpm quarry discover_ats "Acme Corp" --save        # save the company and every board found
pnpm quarry discover_ats --missing --limit 50      # companies that have no board yet
pnpm quarry discover_ats --recheck                 # companies not checked in discovery.recheckDays
```

Detection fetches the company's careers pages (`robots.txt` respected), follows redirects and classifies the
host, then falls back to probing ATS APIs by name. Recheck adds new boards and marks a board stale when the
company moved and the old board stopped working.

### Crawling company lists

```bash
pnpm quarry discover_companies --list yc --dry-run
pnpm quarry discover_companies --list gcc-journal --max-new 50
pnpm quarry discover_companies --all               # what the server runs nightly
```

Lists: `yc`, `gcc-journal`, `wellfound`, `internshala`, `hirect`. Each new company goes through `discover_ats`
and is saved with its boards, deduplicated by domain. Configure per list under `discovery.lists` (enable,
URLs, regions, max new). The dashboard Companies tab shows what was discovered in the last 7 days, with a
banner when a single day adds more than `discovery.alertThreshold`.

## Fetching

```bash
pnpm quarry fetch                                  # every active board + alert emails
pnpm quarry fetch --company Stripe
pnpm quarry fetch --plugin source-workday --concurrency 4
pnpm quarry fetch --no-alerts --verbose
```

The server re-fetches boards whose last fetch is older than `sweeper.fetchEveryHours` (6) on every sweep.

## Job-alert emails

`source-gmail-alerts` reads alert emails from **LinkedIn, Naukri, Wellfound, YC Work at a Startup,
Instahyre, Internshala and Unstop** (one parser per sender) and turns each listed job into a posting. Needs
Gmail connected with read scope ([outreach.md](outreach.md#1-connect-gmail-once)).

```bash
pnpm quarry gmail subscribe-template        # the alert searches to set up on each portal, from preferences.yaml
pnpm quarry gmail alerts --since 2026-10-01 # read alerts only
pnpm quarry gmail alerts --dump <messageId> # print one email's HTML (to build a parser fixture)
```

A parser that fails on an email logs an event and skips it.

## Adding a job by hand

From the dashboard Chat tab or Claude Code (MCP `add_job`), paste any job link; it is fetched, normalized and
enters the pipeline like any other posting.

## Normalization and dedup

Raw postings are stored as-is in `raw_postings`, then normalized (title, seniority, locations, remote policy,
HTML → markdown) into canonical `jobs`. The same role on two boards — or on a board and in an alert email —
becomes one job: fingerprint on company + title + primary location, confirmed by description embeddings.

## Read-only live check

```bash
pnpm live:sources [--save dir]
```

Runs each source plugin once against a real public board through the scoped HTTP client and rate limiter,
writing nothing to the database. Useful after an ATS changes its API.
