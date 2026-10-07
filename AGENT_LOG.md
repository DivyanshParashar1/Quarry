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

