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

