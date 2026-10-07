# JobForge: Phase Plan 6–13 (Vision Alignment)

> Extends `PLAN.md`. Current state: Phase 5.5 sub-phase 2 shipped (block-based resume tailor with LLM selector + skills rewrite).
> Takes the system from "ranked jobs + grounded resume + email outreach" to the full vision: maximum company coverage, per-job referral fan-out across email + LinkedIn, deadline-aware auto-apply.
>
> Same working rules as `PLAN.md` §10 and `CLAUDE.md`: one phase at a time, tests alongside code, stop at phase end for review, no `Co-Authored-By` trailer.

---

## North star

**Beat everyone on company coverage.** The optimization target shifts from "quality applications per hour" to "zero missed GCC/startup openings for the 2027 batch, with a tailored resume and 10+ referral asks per role." Volume of distinct employers is now a first-class metric.

Non-goals carried from `PLAN.md` §1 still hold, with two overrides the user has approved:
- LinkedIn automation is now in-scope **only via Playwright on a user-owned LinkedIn account** (user is setting up a dedicated account for this).
- There is **no global daily send cap**. Per-contact cooldowns and per-sender (Gmail / LinkedIn) technical limits are the only throttles.

---

## Phase 6 — GCC sources: Workday + SmartRecruiters + aggressive tenant discovery

Workday is the single biggest unlock for Indian GCCs (JPMC, Goldman, HSBC, Barclays, Morgan Stanley, Walmart Global Tech, Target, Mastercard, Flipkart). SmartRecruiters is cheap because it has a public Greenhouse-shaped API. Discovery is bumped into this phase because volume > polish.

### Scope
- `plugins/source-workday`
  - POST `https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with cursor-based pagination.
  - Config: `{tenant, site, searchText?, locations?}`. Rate limit 1 req/s per tenant.
  - Normalizer handles Workday's `jobPostingInfo` / `externalPath` fields; description HTML → markdown through the existing pipeline.
- `plugins/source-smartrecruiters`
  - `GET https://api.smartrecruiters.com/v1/companies/{companyId}/postings`. 2 req/s. Shape close to Greenhouse.
- `jf discover_ats <domain|company_name>` — detects which ATS a company's careers page uses by:
  1. Fetch `https://{domain}/careers`, `.../jobs`, `.../join-us` (robots.txt respected).
  2. Follow redirects; classify by host (`*.myworkdayjobs.com` → workday, `jobs.smartrecruiters.com` → sr, `boards.greenhouse.io` → gh, `jobs.lever.co` → lever, `jobs.ashbyhq.com` → ashby, `*.sapsf.com` or `career4.successfactors.com` → sf).
  3. Write a `company_sources` row with the detected `ats_type` and extracted `board_token` / `tenant`.
- `jf discover_companies --list gcc-journal|wellfound|yc` (web-crawl + LLM extraction):
  - Crawls public GCC lists / Wellfound company directories / YC WaaS company list.
  - For each candidate, runs `discover_ats`.
  - Writes `companies` + `company_sources` rows atomically; dedupes by domain.
- `data/companies.seed.csv` grows to **200+ GCCs** (BFSI, retail, pharma, consulting, SaaS). Columns extended for `workday_tenant` / `workday_site` / `smartrecruiters_company_id`.
- Fixtures recorded for every new source; integration tests fixture-only per `CLAUDE.md`.

### Dependencies (new, outside `PLAN.md` §2)
- None expected. Workday and SmartRecruiters use plain `fetch`.

### Done when
- `jf fetch` runs across Greenhouse + Lever + Ashby + Workday + SmartRecruiters sources with 200+ seeded companies, dedupes to canonical jobs, idempotent on rerun.
- `jf discover_companies --list gcc-journal` ingests 50+ new companies in one run, each with a detected `ats_type`.
- A failing tenant doesn't block any other.

---

## Phase 7 — Alert-email + SuccessFactors + Taleo sources

Covers (a) portals we won't scrape (LinkedIn, Naukri, Instahyre) via their own alert emails, and (b) the last two ATSs commonly used by Indian GCCs.

### Scope
- `plugins/source-gmail-alerts`
  - Reuses `GmailHandle` with a new `read` scope.
  - Per-sender parsers (one file each) for: LinkedIn Job Alerts, Naukri Alerts, Wellfound Weekly, YC Work-at-a-Startup digest, Instahyre, Internshala, Unstop.
  - Each parser extracts posting URL, title, company, location; dedupes via the existing fingerprint.
  - User-side setup: a one-shot `jf gmail subscribe-template` command prints the exact search/alert queries to configure in each portal, so the inbox gets steady flow.
- `plugins/source-successfactors`
  - Public endpoints at `career4.successfactors.com/career` and `jobs.{tenant}.sapsf.com`. 1 req/s per tenant.
  - Description is HTML, often with inline styles — stricter sanitization.
- `plugins/source-taleo`
  - Legacy, inconsistent per tenant. Best-effort: `*.taleo.net` with search endpoint discovery. Lower priority than SF but still shipped so BFSI PSUs aren't missed.
- `discover_ats` learns SuccessFactors and Taleo signatures.

### Done when
- Running `jf fetch` on an inbox populated with real alert emails produces canonical jobs for every supported sender.
- At least 5 SuccessFactors tenants and 3 Taleo tenants return postings.
- A sender-parser failure logs an `event` and is skipped; no crash.

---

## Phase 8 — Per-job referral fan-out (10+ contacts per job)

The current cap model (2 per company per week) is wrong for this product. You explicitly want **10+ referral asks per job**, with no global ceiling.

### Scope
- **DB migration 0006**
  - `contacts.role_hint`, `contacts.seniority_hint`, `contacts.department`, `contacts.source` (`pattern` | `linkedin` | `manual`).
  - `review_items.kind` adds `referral_ask` (distinct from `outreach`).
  - `job_referral_batches` — `job_id`, `requested_count` (default 10), `drafted_count`, `sent_count`, `replied_count`, `status`.
  - Removes `per_company_per_week` cap. Replaces with:
    - `per_job_referral_cap` (default 10, user-configurable per job).
    - `per_contact_cooldown_days` (default 30) — a given person is never asked twice within 30 days across any job.
    - Gmail-API-level rate limit (not a product cap): respect quota via existing `DomainRateLimiter`.
- `enricher-contacts-pattern`
  - Learns to produce N candidate emails per company (not one), ranked by pattern confidence + MX result.
- **New enricher** `enricher-linkedin-employees`
  - Playwright, logged-in LinkedIn session (session storage mode 600).
  - Searches `people` filtered by `currentCompany={companyId}` + `title` keywords ("engineer", "SWE", "developer").
  - Extracts N candidate profiles per job: name, title, team, profile URL.
  - Pairs each profile with an inferred email from `enricher-contacts-pattern`.
  - Aggressive rate limit: one search per 60s, exponential cool-down on captcha/warning page.
  - Dry-run first; `--live` + explicit `LINKEDIN_ENABLED=true` to execute.
- `actor-gmail-outreach`
  - New `referral_ask` prompt distinct from cold-outreach: shorter, references the specific job URL and 1 resume bullet relevant to the recipient's team/role.
  - Still grounded; still gated by review.
- `apps/web`
  - Per-job referral panel: all contacts in the batch, send/reply status, "approve all" and per-row controls.
- Autopilot adds `fanOutReferrals(jobId)` which creates a batch and queues N `referral_ask` review items.

### Done when
- One click on a job approves 10 referral review items against 10 distinct contacts (mixed email + LinkedIn).
- Per-contact cooldown prevents the same person being pinged for two different jobs within 30 days.
- A reply on any batch item marks the batch `replied`, cancels remaining follow-ups for that batch only, and signals the autopilot sequencer (Phase 12).

---

## Phase 9 — LinkedIn referral actor (Playwright on user-owned test account)

User is setting up a dedicated LinkedIn account for this phase. ToS/ban risk is accepted and isolated to that account.

### Scope
- `plugins/actor-linkedin-referral` (sideEffects: `external`)
  - Reuses an existing Playwright `BrowserHandle`; `storageState.json` on disk, mode 600, encrypted at rest via OS keychain reference.
  - First-run wizard: open headed browser, user logs in once, state is saved. Subsequent runs are headless.
  - `prepare()` drafts a connection-request note (≤ 300 chars) via LLM, grounded in the Phase 8 referral prompt.
  - `execute()` sequence: navigate → human-ish mouse jitter → Connect → Add note → paste → Send. Screenshot pre and post.
  - Hard per-session cap: **25 connection requests/day** (LinkedIn's documented soft limit for new accounts; configurable, but we start conservative to keep the account healthy — not a global product cap, just a technical safeguard).
  - Fails fast on captcha / MFA / "we restricted your account" page → raises a review item, pauses the loop, no retries.
  - Random gaps 45–120s between actions; longer cool-down after errors.
- `tracker-linkedin`
  - Polls LinkedIn "My Network" + inbox for accepted connections and new messages.
  - Writes replies into `outreach_threads` tied to the originating `referral_ask`.
  - Read-only; same session-health guards.
- Config: `LINKEDIN_ENABLED=false` by default. User turns it on after seeding the dedicated account.

### Done when
- One real connection request lands end-to-end against the user's dedicated test account on a staging contact.
- Session loss / captcha pauses the loop and raises a review item (verified by injecting a 999 "security check" page in a fixture).
- Accepted-connection detection flips the related `referral_ask` to `replied` and feeds Phase 12.

---

## Phase 10 — Deadline inference (LLM + web search)

Per user ask: ask the LLM to web-search historical trends to estimate when applications close (e.g. "when do Walmart Global Tech India SDE intern 2027 applications typically close").

### Scope
- `packages/llm`
  - Add a `webSearch` capability to the `LLMClient` interface.
  - Claude Code adapter uses the CLI's built-in web_search tool.
  - OpenRouter adapter uses tool-use-capable models with a search tool, falling back to a lower-confidence no-search estimate otherwise.
- **DB migration 0007**: `jobs.inferred_deadline date`, `jobs.deadline_confidence real`, `jobs.deadline_rationale text`, `jobs.deadline_sources jsonb` (array of URLs), `jobs.deadline_inferred_at timestamptz`.
- **New enricher** `enricher-deadline`
  - Prompt: "Given this company + role + 2027 batch, what is the typical application close date? Use web search. Cite sources."
  - Zod-validated: `{deadline: ISO date, confidence: 0..1, rationale: string, sources: string[]}`.
  - Re-runs stale (>14 days) inferences; skips closed jobs.
- Dashboard job detail: inferred deadline + confidence + expandable rationale with linked sources.
- Autopilot's "deadline near" predicate (used in Phase 12) = `inferred_deadline - now < deadlineImminentDays` (default 3).

### Done when
- 20 real GCC internship postings get a non-null `inferred_deadline` with cited sources visible in the UI.
- Deadlines expire — a stale posting whose inferred deadline has passed is marked `closed_at` and excluded from autopilot.

---

## Phase 11 — ATS auto-apply via Playwright (Greenhouse → Lever → Ashby)

PLAN.md Phase 5 as originally designed, re-sequenced to land after sourcing + referrals are solid.

### Scope
- `plugins/actor-apply-greenhouse` first (most predictable form shape).
  - `prepare()` builds a field map from profile preferences + latest tailored resume PDF.
  - `execute()` opens Chromium, fills fields, uploads PDF, screenshots full page, submits only after `ApprovedDraft`.
  - Idempotency key `apply:{job_id}:{profile_version}` in `actions`. Retry a completed application returns the prior result.
  - Dry-run default: fills + screenshots, does **not** click Submit. User reviews screenshot before approval.
  - Demographic / EEO answers come from a new `profile/preferences.yaml` section — never auto-invented.
- `plugins/actor-apply-lever` and `plugins/actor-apply-ashby` — same contract, per-portal selectors.
- Workday / SuccessFactors / Taleo auto-apply explicitly deferred — forms vary too much per tenant to be worth the fragility yet; those stay manual-apply with the referral + resume prep done.

### Done when
- One real approved application submits end-to-end on a Greenhouse form with a screenshot audit trail stored in `actions.result.screenshots[]`.
- Lever and Ashby each have one real successful submission.
- Retrying a completed application is a no-op.

---

## Phase 12 — Autopilot sequencing: referral-first, apply-on-deadline

Wires the full user flow: match → tailor → fan out 10+ referrals → wait 2 days or deadline-near → apply.

### Scope
- `packages/core/autopilot.ts` grows a per-job state machine:
  1. `candidate` — passed match + tailor + resume-pass gates (existing).
  2. `referral_pending` — fan out N referral asks (Phase 8 + 9).
  3. Wait condition: any `replied` **OR** `now > referral_sent_at + referralWaitDays` **OR** deadline imminent (Phase 10 predicate).
  4. `ready_to_apply` — queue `apply` review item (Phase 11).
  5. Terminal: `applied` / `expired` / `failed`.
- **DB migration 0008**: `job_pipeline_state` — `job_id`, `state`, `entered_state_at`, `metadata jsonb` (last transition reason, counts).
- Autopilot config:
  - `referralWaitDays` (default 2).
  - `deadlineImminentDays` (default 3).
  - `maxConcurrentJobs` — how many jobs can sit in `referral_pending` simultaneously (default 50, high because volume is the goal).
  - No global send cap (user override).
- `/applications` audit page — every job + its state + full timeline of review items, with filters by state and company.
- MCP: `pipeline_status` surfaces per-state counts; new `advance_job(jobId)` tool for manual override; new `expire_job(jobId, reason)` for the cases where the system should give up.

### Done when
- An approved candidate job automatically fans out N referrals, waits per policy, and either queues an apply draft or marks itself `expired` with a clear reason.
- `/applications` shows the full timeline for 20+ real jobs across all states.
- The autopilot run is resumable: killing the process mid-fan-out and restarting resumes without duplicating asks.

---

## Phase 13 — Continuous company discovery

With the pipeline wired, discovery becomes a background loop so **no company is ever missed**.

### Scope
- Scheduled `discover_companies` job (pg-boss cron, daily):
  - Crawl: gccjournal.in listings, Wellfound company directory, YC WaaS, Hirect India company lists, Internshala company directory.
  - For each new candidate: `discover_ats` → add to `companies` + `company_sources` → ingest into `source.fetch` queue next tick.
- `enricher-company-ats-recheck` — monthly re-check of existing companies whose detected ATS might have changed.
- `apps/web` — `/companies` panel showing newly discovered companies (last 7 days), with manual override to tag/exclude.
- Alerting: when discovery adds > N companies in a day, surface a dashboard banner — makes it obvious when something upstream has drifted.

### Done when
- Discovery runs nightly, adds 10–30 new companies/week on average, zero duplicates, each with a working source.
- A company that silently moves from Greenhouse to Workday is detected within 30 days and the old source is marked stale.

---

## Phase 14 (stretch) — Operational hardening at volume

Only after Phases 6–13 are stable. Volume stresses the system in ways the current scale (10s of jobs/day) doesn't.

- Plugin process isolation (child processes with RPC) — contain crashes when running 200+ sources.
- Per-source funnel analytics; reply rate per outreach template; time from posting to referral-reply to apply.
- Digest email (daily): new postings, pending reviews, state transitions.
- Backpressure on the review queue — when `pending` crosses a threshold, autopilot pauses new fan-outs until reviewed.

---

## Open items carried into Phase 6 kickoff

1. **Workday tenant seeding** — I'll research the top 50 GCC Workday tenants and seed them in Phase 6. User can supply a shortlist if preferred.
2. **LinkedIn test account** — user is setting up. Phase 9 is blocked on that account existing + logged in once via the first-run wizard.
3. **No global cap confirmed** — Phase 8 removes the per-company-per-week cap entirely. Per-contact cooldown (30 days) is the only product-level throttle; everything else is a technical rate limit on the sender (Gmail quota, LinkedIn per-day).
4. **Dedicated Gmail for outreach?** — not asked, but at this volume the user's primary Gmail may hit sending reputation issues. Flag for the Phase 8 kickoff; may need a dedicated Google Workspace or app password.

---

## Working order

Strict sequential, one phase at a time per `CLAUDE.md`:

**6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → (14)**

Each phase ends with: full test suite green, `CHANGELOG.md` entry, phase summary, stop for review.
