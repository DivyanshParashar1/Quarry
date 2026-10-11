Taleo apply fixtures.

Recorded 2026-10-11 from a live career section, read-only (GETs only, nothing typed or submitted):
- `aa224-jobapply-redirect.html` — `GET aa224.taleo.net/careersection/ex/jobapply.ftl?job=JR111341&lang=en`: a JS redirect
  to `/careersection/iam/accessmanagement/login.jsf?…&redirectionURI=<the jobapply URL>`.
- `aa224-login.html` — that login page (scripts/styles stripped). Field ids: user name
  `dialogTemplate-dialogForm-login-name1`, password `dialogTemplate-dialogForm-login-password`, Login button
  `dialogTemplate-dialogForm-login-defaultCmd`, "New User" `dialogTemplate-dialogForm-login-register`.

`flow/*.html` are **synthetic** (registration, the emailed code, the privacy agreement, the flow pages and the
confirmation): they need an account and data typed into a real employer's flow. Ids follow Taleo's
`dialogTemplate-dialogForm-*` (account pages) and `et-ef-content-ftf-*` (flow pages) conventions; Phase 23 verifies
them, and a mismatch becomes a per-tenant override (`tenants.<tenant>.selectors` / `steps`).
