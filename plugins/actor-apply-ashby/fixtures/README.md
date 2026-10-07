# actor-apply-ashby fixtures

**Synthetic.** `form.json` imitates the response of Ashby's public
`POST https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting` (`applicationForm.sections[].fieldEntries[].field` with `path`, `title`, `type`, `selectableValues`). `application.html` is a minimal stand-in for the hosted form. Ashby renders ValueSelect/Boolean as custom radio-like controls; the selectors (`input[name=path][value=…]`) need checking against the real form.
