SmartRecruiters one-click apply, recorded 2026-10-11 from a public Bosch Group posting (read-only:
nothing was typed or submitted).

- `bosch-posting.json` — trimmed `GET api.smartrecruiters.com/v1/companies/BoschGroup/postings/744000154820678`.
  The form is `jobs.smartrecruiters.com/oneclick-ui/company/{company.identifier}/publication/{uuid}`.
- `bosch-form-head.html` — the part of the form page that matters: it embeds the company's internal id
  (`"company":{"id":"58652035…"`), which the config endpoint needs. The rest of the page is a
  web-components app (shadow DOM), trimmed here.
- `bosch-config.json` — `GET /oneclick-ui/api/company/{internal id}/publication/{uuid}/config`: which
  step-1 field sets are visible/required.

Step 1 field ids (inside shadow roots; Playwright CSS selectors pierce open shadow DOM):
`#first-name-input`, `#last-name-input`, `#email-input`, `#confirm-email-input`, City autocomplete
(`spl-autocomplete[data-test=location-autocomplete]`), phone `input[type=tel]` with a country-code select,
`#linkedin-input`, `#website-input`, resume dropzone `spl-dropzone[data-test=resume-upload] input[type=file]`,
`#hiring-manager-message-input`; Experience/Education are "Add" sub-forms (optional here); the footer
button is `oc-button[data-test=footer-next]` ("Next").

Not recorded (it needs data typed into a real employer's form and "Next" pressed): step 2 — screening
questions, consent checkboxes and the final Submit. The actor discovers those at run time; their
selectors are synthetic until Phase 23 verifies them live.
