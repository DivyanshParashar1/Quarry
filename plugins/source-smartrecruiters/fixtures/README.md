# source-smartrecruiters fixtures

**Synthetic** (no network access to api.smartrecruiters.com in the session that
wrote the plugin). Built from the public Posting API shape:

- `GET https://api.smartrecruiters.com/v1/companies/{companyId}/postings?limit=100&offset=N` →
  `{ offset, limit, totalFound, content: [{ id, name, refNumber, releasedDate, location: { city, region, country, remote }, department, experienceLevel, ref, ... }] }`
- `GET https://api.smartrecruiters.com/v1/companies/{companyId}/postings/{id}` → the same
  fields plus `postingUrl`, `applyUrl`, `jobAd.sections.{companyDescription,jobDescription,qualifications,additionalInformation}.{title,text}`.

An unknown company id returns `200` with `totalFound: 0` rather than a 404.
Re-record with e.g. `curl -s 'https://api.smartrecruiters.com/v1/companies/Visa/postings?limit=5'`.
