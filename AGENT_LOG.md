# Agent log — Phases 6–13 overnight run

Running log of decisions, issues noticed, and ideas, written while implementing
`PLAN-phases-6-13.md` unattended. Newest entries are appended at the bottom of each
section. Each phase also gets a `CHANGELOG.md` entry.

## Environment / session notes

- Docker daemon is not available in the session container, so Postgres 16 was
  installed from apt (`postgresql-16-pgvector`) and started as a system service with
  the same `jobforge/jobforge` credentials as `docker-compose.yml`. DB tests ran with
  `JOBFORGE_REQUIRE_DB=1`, so none of them were silently skipped.
- **Outbound network is restricted to package registries.** Workday, SmartRecruiters,
  SuccessFactors, Taleo, LinkedIn, YC, etc. are all blocked (HTTP 403 from the egress
  proxy; WebFetch too). That means **every new fixture in this run is synthetic**,
  hand-built from the documented / commonly observed API shapes rather than recorded
  from a live endpoint. Each such fixture directory has a README saying so.
  **Action for you:** re-record fixtures against the live endpoints (see each
  plugin's README for the exact URL) before trusting the field mappings.
- Similarly, "done when" criteria that need real accounts or real endpoints (real
  LinkedIn connection request, real Greenhouse submission, 50+ companies from a live
  crawl, 20 real deadlines) could not be exercised here. They are covered by
  fixture-driven tests; the live runs are left for you.

## Baseline fixes (before Phase 6)

- `assembler.test.ts` read the gitignored `my_resume.tex` and failed on a clean
  clone. It now `skipIf`s when the file is absent.
- Three pre-existing lint errors (`{}` type in a test, a constant `|| true`
  condition in the assembler) fixed so `pnpm lint` is clean.

## Phase 6 — Workday + SmartRecruiters + discovery

### Decisions
- **Wildcard hosts in manifests.** Workday serves each tenant from its own host
  (`walmart.wd5.myworkdayjobs.com`), so an exact-host allowlist can't express the
  plugin's permissions. Manifests now accept a *leading-label* wildcard
  (`*.myworkdayjobs.com`). It never matches the apex and the suffix needs ≥2 labels,
  so `*.com` / `*` remain invalid.
- **Per-target options.** The plan's Workday config `{tenant, site, searchText?,
  locations?}` is split: tenant+site live in `board_token` (`walmart.wd5/WalmartExternal`),
  while `searchText`/`locations`/`maxPostings`/`fetchDetails` are plugin config that can
  be overridden per board via a new `company_sources.config` jsonb column.
- **Offset, not cursor, paging for Workday.** The CXS API pages with `offset`/`limit`
  (max 20). It only reports a reliable `total` on the first page, so the loop stops on a
  short/empty page or when `offset >= total`.
- **Location filtering happens before detail requests.** A big tenant (Walmart, JPMC)
  has thousands of postings worldwide; at 1 req/s the detail fetches dominate. The
  list's `locationsText` is filtered first, and "2 Locations" summaries are resolved
  from the detail. Default config is *no* filter (coverage first) — **you probably
  want `plugins.source-workday.locations: [India]`** in `config.yaml`.
- **Discovery isn't a plugin.** `discover_ats` must visit arbitrary company domains,
  which no plugin allowlist can express. It lives in core and uses a dedicated
  `PageFetcher` that is https-only, robots.txt-checked on *every redirect hop*,
  rate-limited (1 req / 2 s / host) and body-capped. ATS token formats moved into the
  plugin SDK so plugins and the detector share one parser.
- **Extra careers URLs.** Besides the plan's `/careers`, `/jobs`, `/join-us`, the
  detector also tries `careers.<domain>` and `jobs.<domain>` (very common for GCCs) and
  follows up to 3 same-site "jobs/careers/openings" links one hop deeper.
- **Name probes as a fallback.** When pages give nothing, slugs from the company name
  are probed against the public Greenhouse/Lever/Ashby/SmartRecruiters APIs. Those hits
  get lower confidence (0.45–0.75) because a slug match can be a different company.
  Workday can't be probed by name (needs the data-centre number and site).
- **Migration numbering shifted.** The plan reserves 0006/0007/0008 for Phases 8/10/12.
  Phase 6 needed its own migration (new ATS enum values etc.), so later phases'
  migrations are numbered one higher than the plan says.
- **All four new ATS enum values were added in Phase 6** (incl. successfactors/taleo for
  Phase 7) to avoid another enum migration, since the detector already recognises them.
- **Companies without a detected ATS are still saved** during `discover_companies`
  (with `ats_checked_at` set), because the north star is coverage; the Phase 13 recheck
  retries them. The run summary separates "with a board" from "without".
- **robots.txt semantics:** 4xx → allow all; 5xx → disallow all (RFC 9309); network
  failure → "unreachable" (reported as an error, not as a robots block).

### Issues noticed
- **JPMorgan Chase is not on Workday** as far as I know (it uses Oracle HCM). The plan
  lists it among Workday GCCs. It's seeded with a domain only.
- **Workday/SmartRecruiters seed boards are from memory**, marked `unverified seed` in
  the `notes` column. Run `jf fetch --plugin source-workday` and fix/pause the ones
  that 404 (they fail independently; nothing else is blocked).
- **SmartRecruiters returns `200 {totalFound: 0}` for unknown company ids**, so a typo'd
  id looks like an empty board rather than an error. It's logged at info level.
- **Internshala / Hirect / Wellfound list URLs are guesses**; Wellfound in particular is
  heavily bot-protected and will probably fail. URLs are configurable per list in
  `config.yaml → discovery.lists.<id>.urls`.
- **The GCC Journal URL** (`gccjournal.in/insights/list-of-global-capability-centers-gcc-in-india/`)
  was found via web search; the page claims 200+ GCCs, so one run should satisfy the
  "50+" acceptance if its HTML is server-rendered.
- **Pre-existing:** `apps/cli/src/plugins.ts` and `apps/server/src/plugins.ts` duplicate the
  plugin list (the server's lacks `matcher-default`). Each new plugin has to be added in
  both places.

### Ideas
- iCIMS, Oracle Recruiting Cloud (JPMC, Citi), Eightfold (Microsoft-ish), Phenom and
  Avature are common for big GCCs too; adding them would close the biggest remaining
  coverage holes after Workday.
- A `jf sources verify` command that fetches one page of every `unverified seed`
  board and pauses the ones that 404 would make the seed self-healing.
- Workday tenants could be discovered by probing `{slug}.wd{1,3,5,12,103}.myworkdayjobs.com`
  (only ~6 data centres), turning name-only companies into Workday boards.

## Phase 7 — job-alert emails, SuccessFactors, Taleo

### Decisions
- **The alert source isn't company-scoped**, so it gets its own runner
  (`runAlertSource`) instead of going through `company_sources`. Each posting carries
  `companyName`; the runner maps it to a known company with a looser key that drops
  "India", "GCC", "Technology Centre", legal suffixes etc., so alert jobs merge with the
  ATS postings of the same company (the fingerprint includes the company name).
- **Alerts never close jobs** (an alert not repeating a job means nothing).
- **Parse failures are events.** Plugins previously had no way to write audit events.
  I added an optional `ctx.emit(kind, data)` to the plugin context; the core persists
  calls as `plugin.<id>.<kind>` events. Used for `parse_empty` / `parse_failed`.
- **No HTML parser dependency.** Alert emails are flattened into text/link tokens with
  regexes and parsed as "cards" grouped by the job id in the link. Each sender is one
  small declarative file (sender list, job-URL regex, canonical URL, optional meta rule).
- **YC digests put the company before the role**, so parsers can declare
  `metaPosition: 'before'`.
- **SuccessFactors custom domains aren't supported** by the plugin (its manifest can
  only list SAP hosts). `discover_ats` still records them at low confidence (0.4, below
  the 0.5 save threshold) so they're visible but not fetched.
- **Taleo descriptions are not fetched**: Taleo renders job details client-side from an
  escaped blob; parsing it reliably needs real samples. Matching uses the title until
  the same job shows up from another source.
- **The server polls alerts in dev mode too**: it's read-only Gmail access.

### Issues noticed
- All alert fixtures are synthetic — the real templates will differ. The README in
  `plugins/source-gmail-alerts/fixtures` explains how to dump a real alert
  (`jf gmail alerts --dump <id>`) and update the parser.
- Gmail's `after:` operator works on seconds since epoch but some clients treat it as
  a date; the runner re-reads one day of overlap. Dedup makes that harmless.
- `jf fetch` previously only exited 1 when *every* board failed; with alerts included,
  it exits 0 if either boards or alerts succeeded.

### Ideas
- Alert emails often carry a "posted N days ago" line; parsing it would give alert-only
  jobs a `posted_at`, which the deadline logic (Phase 10) could use.
- A LinkedIn alert job id could be enriched later by the Playwright session (Phase 8/9)
  to fetch the description, which would let the matcher score alert-only jobs properly.

## Phase 8 — referral fan-out

### Decisions
- **Caps.** Followed the plan's user-approved override: the global daily cap and the
  per-company weekly cap default to *off* (`null`) but remain available as opt-in
  config, so nothing that relied on them breaks. The always-on product throttles are
  the 30-day per-contact cooldown and the per-job referral cap; Gmail gets a
  *technical* `senderDailyLimit` of 400/day (consumer Gmail starts rejecting around
  500/day). I updated the matching hard-rule line in `CLAUDE.md`.
- **Cooldown counts queued asks too.** A contact with a *pending or approved* ask (for
  any job) can't be queued again, otherwise two fan-outs run back to back would both
  draft the same person. Executed asks block for 30 days.
- **Limits are re-checked at send time**: an approved item that became invalid
  (someone else's ask for that person went out first) fails with the reason instead
  of sending.
- **One batch per job** (unique index). Re-running the fan-out tops the batch up to its
  requested count without duplicating anyone — this is what makes it resumable.
- **Channel choice:** email if the address confidence ≥ 0.3 (`referralMinEmailConfidence`),
  else LinkedIn if we know the profile, else the person is skipped with a reason.
- **"10 distinct contacts mixed email + LinkedIn"** — the LinkedIn half needs the Phase 9
  actor; the fan-out already drafts LinkedIn items (validated LinkedIn-note drafts),
  and email items go through the existing send loop, which now only picks items whose
  actor is `actor-gmail-outreach`.
- **Referral email cites one resume bullet** taken from the job's tailored `.tex`
  (`\resumeItem{…}` → plain text), so the ask matches what the referrer will forward.
  Falls back to profile facts. The bullet id is validated (repair retry otherwise) and
  the posting URL is appended if the LLM dropped it.
- **Browser capability design:** plugins get a Playwright-compatible `BrowserPage`
  subset through a core wrapper that enforces the manifest's domains on every
  navigation and the per-domain rate limit — the same allowlist idea as ScopedHttp.
  Tests use a scripted `fakeBrowser`; no real browser runs in CI.
- **Session at rest:** AES-256-GCM, file mode 600; key from `JOBFORGE_SESSION_KEY`, else
  the OS keychain via the `security` (macOS) / `secret-tool` (Linux) CLIs, else a 600
  key file in `~/.config/jobforge/` (weakest; used in this sandbox since there's no
  keychain). No keychain npm dependency.
- **Blocks pause everything and raise a review item.** I added a review kind
  `attention`: approving it means "I fixed it, resume". The cool-down doubles on each
  block (capped at a week) and resets on resume.
- **Autopilot hook deferred to Phase 12** — the plan's `fanOutReferrals(jobId)` exists
  and is used by CLI/server/MCP; the autopilot calls it once the Phase 12 state machine
  exists, to avoid writing the integration twice.

### Issues noticed
- The `contacts` unique key is (company, lower(name)). Two different people with the
  same name at one company (common in India: "Rahul Sharma") collapse into one
  contact. LinkedIn imports could key on the profile URL instead — worth a migration.
- Bounced pattern-guessed addresses mark the contact `bounced` forever even though the
  enricher now stores ranked alternatives; see the idea below.
- I could not run Playwright against LinkedIn here (no network, no account). The
  selectors and the markup parser are educated guesses — expect to adjust them on the
  first headed run (`BROWSER_HEADLESS=false`).

### Ideas
- On a bounce, automatically try the next `email_candidates` address (the ask never
  arrived, so the cooldown shouldn't apply to that one).
- Rank referral targets by team match: compare the contact's `department` with the job
  title/description (e.g. "Payments") using the existing embeddings.
- Show "asked N days ago for <job>" on contacts in the Outreach panel so the cooldown is
  visible before the fan-out skips someone.

## Phase 9 — LinkedIn actor + tracker

### Decisions
- **An accepted connection counts as a reply.** The plan says acceptance "flips the
  related referral_ask to replied and feeds Phase 12", so the thread is marked
  `replied` on accept, which triggers the batch-replied logic.
- **No follow-ups on LinkedIn threads** — you can't message someone until they accept,
  and re-sending requests is what gets accounts restricted.
- **Never twice:** before clicking Connect the actor checks for *Pending* / *1st degree*
  on the profile, so a retry after a crash (or a request sent by hand) is a no-op.
  The `actions` idempotency key (`li:<itemId>`) covers the rest.
- **A block leaves the item approved** (not failed) with a `paused:` note, so after the
  human resolves the attention item the same ask goes out without re-approval.
- **Typing via `pressSequentially`** (Playwright's per-key typing) with 40–140 ms delays.
- **Tracker matching** is by canonical profile URL for accepts and by contact name for
  inbox replies (LinkedIn's inbox list doesn't carry profile URLs). Name collisions
  are possible but only affect which thread gets marked replied.
- Made the browser capability **optional when building a context**: `prepare()` must
  not need a browser (no side effects), so the plugin only fails if it actually tries
  to browse without one.

### Issues noticed
- Found and fixed while testing: LinkedIn uses curly apostrophes (“You’ve reached the
  weekly invitation limit”), which the block-detection regexes initially missed.
- The real LinkedIn rate limits slept 15 s per navigation inside a test; the test now
  uses the virtual clock. Worth remembering for any new browser-plugin test.

### Ideas
- Store the LinkedIn messaging thread URL on the outreach thread when a reply arrives,
  so the dashboard can link straight to the conversation.
- After an accept, offer to draft a short LinkedIn message (≤ 1000 chars) with the
  resume link — a natural "follow-up" that only exists once connected.

## Phase 10 — deadline inference

### Decisions
- **Web search is a request flag, not a separate client method.** `LLMRequest.webSearch`
  plus `LLMResponse.webSearch.used` lets the enricher know whether the answer was
  actually researched; unsearched answers get their confidence capped (0.35), and
  searched-but-uncited ones at 0.5.
- **New `research` LLM task** so deadline estimates can be routed to a model with good
  search (e.g. an OpenRouter `:online` model) independently of matching/outreach.
- **Batch year is plugin config** (`plugins.enricher-deadline.batch`, default "2027"):
  the enricher contract only receives (job, company), not the profile.
- **Only well-matched jobs get estimates** (LLM-scored ≥ 60 by default): each estimate
  is a paid, web-searching call.
- **Expiry needs confidence ≥ 0.6 and a 1-day grace period.** Closing a job is a strong
  action based on an *estimate*; a 0.3 "industry norm" guess shouldn't close anything.
- **`jobs.closed_reason`**: previously any re-fetch reopened a closed job. Deadline/
  manual closures now stick; "gone" closures still reopen when the posting returns.
- The nightly deadline loop is **off by default** (`deadlines.nightly`) because it costs
  money; `jf deadlines` / the dashboard button run it on demand.

### Issues noticed
- The Claude CLI's `--allowedTools` flag name/format may differ between CLI versions
  (`--allowed-tools` exists too). I used `--allowedTools WebSearch WebFetch`; if the
  installed CLI rejects it, `jf llm check` won't catch it (it makes no model call) — the
  first `jf deadlines` run will. Worth a manual smoke test.

### Ideas
- Feed deadlines into match ranking ("closing soon" boost) so urgent roles surface.
- Cache estimates per (company, role family, batch): ten Walmart intern postings
  share one deadline pattern; one search could serve all of them.

## Phase 11 — ATS auto-apply

### Decisions
- **Questions are read without side effects in `prepare()`** (Greenhouse job API with
  `?questions=true`, Lever's apply page, Ashby's public GraphQL form query), so the
  reviewer sees every question and the exact answer that will be typed.
- **No LLM in the form filler.** Answers come only from the new `application` section of
  `preferences.yaml`; anything else ("Why do you want to work here?", expected CTC)
  stays blank and blocks approval until the human answers it in the review card. This
  is the strictest reading of "never auto-invented".
- **EEO:** null = leave blank (they're optional on all three ATSs); `decline` picks the
  form's own decline option; any other value must match an existing option.
- **Added an optional `preview()` to the actor contract** — the plan's "dry-run fills +
  screenshots, user reviews the screenshot before approval" needed a side-effect-free
  way to fill a form before anything is approved.
- **Greenhouse uses the classic embed form** (`boards.greenhouse.io/embed/job_app`)
  because its fields have stable ids and native selects; the newer hosted forms use
  React comboboxes that `selectOption` can't drive.
- **Idempotency key `apply:{job}:{profile_version}`** exactly as planned. A second
  approved item for the same job+profile replays the stored result. A previously
  *failed* key is handed to the new item rather than blocking forever.
- **Captchas are never solved**: the item fails with "needs a manual application".
- `application` is **excluded from the profile version hash**, otherwise filling it in
  would invalidate every match result and cost a full re-match.

### Issues noticed
- The profile snapshot (`profile_snapshots.preferences`) now stores applicant details
  incl. optional EEO answers in the local DB. That's the same trust boundary as the
  YAML file, but worth knowing.
- Lever and Ashby both commonly put an hCaptcha/reCAPTCHA on submit; expect a share of
  applications to end as "needs a manual application".

### Ideas
- Let the LLM *suggest* answers for free-text questions (clearly marked "suggested",
  still requiring a human edit before approval).
- Store ATS question → answer pairs the human typed, and offer them as `answers` entries
  next time a similar label shows up.

## Phase 12 — sequencer

### Decisions
- **New module, old loop kept.** The sequencer lives in `sequencer.ts`; the Phase 4.5
  one-email autopilot stays available as `autopilot.strategy: single_email`. The
  default strategy is `referrals`.
- **The wait clock starts at the first ask that actually went out** (`batch.firstSentAt`),
  not when asks were drafted — otherwise asks stuck in review would "time out" before
  anyone received them. If nothing was ever sent, the wait counts from entering the
  state, and the reason says `wait_elapsed_no_ask_sent`.
- **Auto-approval of asks has its own budget** (`maxAutoApprovedAsksPerDay`, 200). The
  older `maxAutoApprovesPerDay` (10) would throttle a 10-asks-per-job pipeline to one job
  a day, which contradicts the plan's volume goal. Low-confidence drafts stay pending.
- **Applications are never auto-submitted by default** (`autoApproveApplications: false`):
  the plan says "queue apply review item"; submitting a job application on your behalf
  without a look felt like the wrong default even in autopilot.
- **Expiry respects in-flight applications**: a job whose application is approved
  isn't expired just because its posting closed in the meantime.
- **Unsupported ATS → `manualApply` flag** (stays `ready_to_apply`); "Mark applied" /
  `advance_job` records that you applied by hand.
- Transitions use a row lock + `where state in (...)`, and the whole tick runs under an
  app_state lease, so overlapping cron runs can't double-step a job.

### Issues noticed
- Contacts are shared across a company's jobs, and the 30-day cooldown means the second
  job at the same company in a month usually has nobody left to ask → it goes straight
  to `ready_to_apply` (`no_referral_contacts`) unless LinkedIn search finds new people.
  That's the plan's rules working as written, but worth knowing: at 10 asks/job, a
  company needs 10 fresh people per job per month.

### Ideas
- Prefer re-using a referrer who already replied positively at the same company (a
  "warm" contact) instead of cold-asking new people for the second job — would need a
  cooldown exception for people who said yes.


## Phase 13 — continuous discovery

### Decisions
- **The ATS re-check lives in core, not in a plugin**, although its run is recorded
  as `enricher-company-ats-recheck` as the plan names it. A plugin gets a fixed host allowlist,
  and the re-check has to fetch arbitrary company domains. Core already has the
  robots-respecting `PageFetcher` that Phase 6 discovery uses.
- **"Stale" means paused, never deleted**, and a board is only marked stale when both
  of these hold: (a) the careers site now points at a different board, and (b) the old
  board is in `error` or its last successful fetch returned 0 postings. Many companies
  run two ATSs at once (e.g. Lever for engineering and Workday for corporate). Pausing
  a board that still works just because a second one showed up would lose jobs.
- **Name-probe detections don't count** for a company that already has an active
  board. Probing `greenhouse.io/<slug>` can hit a different company with the same
  name. That is acceptable for a company with nothing, but not as evidence that a
  known company moved.
- **Exclusion is a tag (`excluded`)**, not a new column. It works with the existing
  tags array. Excluded companies are skipped by `listSourceTargets` (so nothing is
  fetched) and by the re-check.
- **Nightly discovery is opt-in (`discovery.nightly: false`)**. It crawls third-party
  directories every night, and a fresh checkout shouldn't do that until you've looked
  at the list config. Turn it on in `config.yaml`. The re-check cron is gated on the
  same flag.
- The drift banner counts companies added in the last 24h (not discovered via CSV). It
  shows on every tab, because the point is to notice it without going looking.

### Issues noticed
- `markAtsChecked` originally stamped the wall clock instead of the injected `now`. The
  test caught it: with a simulated "31 days later", the next run re-checked everything
  again. It's fixed now.
- The re-check limit is 50 companies/day by default. With 280 seed companies plus
  growth, each company gets looked at roughly every 30 days, which matches the plan's
  "monthly". Beyond about 1,500 companies, raise `--limit` or the cron's limit.
- The Companies tab only lists *discovered* companies (not CSV imports), as the plan
  scopes it. To exclude a CSV company today, use `tag_company` from MCP or the API.

### Ideas
- A "boards" health view: every company_source with its last run, posting count and
  error streak. The data is all in `plugin_runs` already. It would make stale-board
  review manual-friendly.
- Feed list-source drift into the banner by source: "YC added 120 today" tells you
  which parser broke.
