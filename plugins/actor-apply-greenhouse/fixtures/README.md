# actor-apply-greenhouse fixtures

**Synthetic.** `job-questions.json` follows the public job API with `?questions=true`
(`questions`, `location_questions`, `compliance`); `embed-form.html` imitates the
classic embedded form (`boards.greenhouse.io/embed/job_app?for=<board>&token=<id>`)
with id-addressed fields and `#submit_app`. Re-record before trusting; newer hosted
forms on job-boards.greenhouse.io use React comboboxes instead of native selects.
