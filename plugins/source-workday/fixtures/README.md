# source-workday fixtures

**Synthetic.** The session that wrote this plugin had no network access to
`*.myworkdayjobs.com`, so these files were hand-built from the CXS API shape
commonly observed on public Workday career sites:

- `POST https://{tenant}.wdN.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`
  body `{"appliedFacets":{},"limit":20,"offset":N,"searchText":""}` →
  `{ total, jobPostings: [{ title, externalPath, locationsText, postedOn, bulletFields }] }`
  (`total` is only reliable on the first page).
- `GET https://{tenant}.wdN.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}` →
  `{ jobPostingInfo: { title, jobDescription, location, additionalLocations, startDate, jobReqId, externalUrl, remoteType, ... }, hiringOrganization }`.

Re-record against a real tenant before trusting the mapping, e.g.

```sh
curl -s -X POST -H 'content-type: application/json' \
  -d '{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}' \
  https://walmart.wd5.myworkdayjobs.com/wday/cxs/walmart/WalmartExternal/jobs > walmart-page-0.json
```
