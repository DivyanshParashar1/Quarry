SuccessFactors apply fixtures.

Recorded 2026-10-11 (read-only GETs; scripts/styles stripped):
- `cargill-job.html` — a live Recruiting Marketing (RMK) job page,
  `jobs.cargill.com/job/Bangalore-Sr_-Software-Engineer-Karn-560087/1372916957/`. Its "Apply now" links
  `/talentcommunity/apply/1372916957/?locale=en_US`. (jobs.cargill.com is the employer's own domain, which the
  actor can't reach; the tests serve this page under a `*.sapsf.com` host.)
- `agfa-job-filled.html` — `careers.agfa.com/job/Mumbai-ICS-Solution-Architect-HR/1202266601/`, a filled posting
  ("Sorry, this position has been filled.").

`flow/*.html` are **synthetic** (sign-in, create account, data-privacy statement, the one-page application, the
confirmation): the apply flow needs JavaScript, cookies and an account, and opening it was not done. Ids follow the
RMK candidate pages as remembered (`fbclc_*`, `dataPrivacyId`) and are re-verified in Phase 23; a mismatch becomes
a per-tenant override (`tenants.<host or company id>.selectors`).
