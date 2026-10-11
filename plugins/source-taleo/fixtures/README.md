# source-taleo fixtures

**Synthetic.** Taleo differs per tenant; the plugin is best effort:

1. `GET https://<tenant>.taleo.net/careersection/<section>/jobsearch.ftl?lang=en` →
   the portal id is read from the page (`portal=101430233`); `jobsearch.html` imitates that.
2. `POST https://<tenant>.taleo.net/careersection/rest/jobboard/searchjobs?lang=en&portal=<id>`
   with the JSON body in `searchBody()` → `{ requisitionList: [{ jobId, contestNo, column: [title, "[\"India-Mumbai\"]", date] }], pagingData: { totalCount } }`.

Descriptions are not fetched (Taleo renders them client-side). Re-record against a
real tenant and, if the column order differs, set it per board in `company_sources.config`.

**Recorded 2026-10-11 (Phase 23, read-only)** from `aa224.taleo.net/careersection/ex` (a classic career section):
- `aa224-moresearch.html` — the search page (scripts stripped): it carries **no REST portal id**.
- `aa224-moresearch-page1.txt` — `POST /careersection/ex/moresearch.ajax` (form body from `classicListBody(1)`): the
  `!|!`-delimited pager answer — per requisition jobId, title, contest number, location; `listRequisition.size` (25)
  and `listRequisition.nbElements` (753). The plugin falls back to this when no portal id is found.
