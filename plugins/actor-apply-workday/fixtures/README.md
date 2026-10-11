Workday apply fixtures.

Recorded 2026-10-11 (read-only GETs of the public CXS API, descriptions trimmed):
- `workday-detail.json` — `GET workday.wd5.myworkdayjobs.com/wday/cxs/workday/Workday/job/INDPune/DataOps-Engineer_JR-0109475-1`
  (tenant `workday`, own host).
- `wf-detail.json` — `GET wd1.myworkdaysite.com/wday/cxs/wf/WellsFargoJobs/job/Bengaluru-India/Principal-Engineer_R-564508-1`
  (Wells Fargo, shared `myworkdaysite.com` host).

Also checked on the live posting page (nothing clicked): the Apply button is `a[data-automation-id="adventureButton"]` and links to
`{job URL}/apply`; the actor goes straight to `{job URL}/apply/autofillWithResume` (or `/apply/applyManually`).

`wizard/*.html` are **synthetic**: recording them needs a candidate account on a real employer's tenant and
data typed into its wizard, which was not done. They follow Workday's `data-automation-id` conventions
(`email`, `password`, `verifyPassword`, `createAccountCheckbox`, `createAccountSubmitButton`, `signInSubmitButton`,
`file-upload-input-ref`, `legalNameSection_firstName`, `phone-number`, `progressBarActiveStep`,
`bottom-navigation-next-button`, `errorMessage`, listbox dropdowns as `<button aria-haspopup="listbox">`).
Phase 23 verifies them live; a mismatch there becomes a per-tenant selector override (`tenants.<tenant>.selectors`).
Fields marked `data-label` are what the fake browser's `describeForm()` reports (questions found at run time).
