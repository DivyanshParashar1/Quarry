# source-workday fixtures

- `real-*.json` were **recorded from live tenants on 2026-10-09**:
  - `real-statestreet-page-0.json`: `POST https://statestreet.wd1.myworkdayjobs.com/wday/cxs/statestreet/Global/jobs`
    (`{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}`).
  - `real-statestreet-details.json`: two detail `GET`s for that page. The first really answers
    `403 permission denied`, which the plugin must survive by keeping the list-level posting.
  - `real-abbott-page-0-with-stub.json`: an Abbott list page containing a stub entry
    (`{"bulletFields":[...]}` with no title or path), which real boards return now and then.
- `walmart-*.json` are hand-built scenario fixtures (paging, "N Locations", location filter). Their
  shapes match the recorded files.

Things learned from the live run: unknown or moved tenants/sites answer `422` with no redirect
(tenants move data centres, e.g. `walmart.wd5` → `walmart.wd504`), and a site can exist with zero
postings once a company leaves Workday.
