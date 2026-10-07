# source-taleo fixtures

**Synthetic.** Taleo differs per tenant; the plugin is best effort:

1. `GET https://<tenant>.taleo.net/careersection/<section>/jobsearch.ftl?lang=en` →
   the portal id is read from the page (`portal=101430233`); `jobsearch.html` imitates that.
2. `POST https://<tenant>.taleo.net/careersection/rest/jobboard/searchjobs?lang=en&portal=<id>`
   with the JSON body in `searchBody()` → `{ requisitionList: [{ jobId, contestNo, column: [title, "[\"India-Mumbai\"]", date] }], pagingData: { totalCount } }`.

Descriptions are not fetched (Taleo renders them client-side). Re-record against a
real tenant and, if the column order differs, set it per board in `company_sources.config`.
