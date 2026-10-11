# source-successfactors fixtures

**Synthetic** (no network access while writing the plugin).

- `classic-feed.xml` imitates the classic career-site XML feed:
  `https://career4.successfactors.com/career?company=<id>&career_ns=job_listing_summary&resultType=XML`.
  Element names vary between tenants; the parser accepts several aliases
  (`ReqId`/`Req-Id`/`JobReqId`, `JobTitle`/`Title`, `Job-Description`/`Description`, …).
- `rmk-search-*.html` / `rmk-job.html` imitate a Recruiting Marketing (RMK) site
  (`https://jobs.<tenant>.sapsf.com/search/?q=&startrow=N`, rows `tr.data-row` with
  `a.jobTitle-link`, `span.jobLocation`, `span.jobDate`, label "Results 1 – 25 of N";
  job pages with `span.jobdescription`).

Re-record against real tenants before trusting either parser.

**Recorded 2026-10-11 (Phase 23, read-only):** `cargill-search-tiles.html` — `jobs.cargill.com/search/?q=&…&startrow=0`
(scripts/styles stripped). Newer RMK sites render results as tiles (`li.job-tile.job-id-N`, `a.jobTitle-link`,
`div#job-N-desktop-section-location-value`, "Showing 1 to 25 of 1826 Jobs"), which the parser now reads alongside
the table layout. Cargill's site is on its own domain, which the plugin's manifest can't reach (see CHANGELOG Phase 23).
