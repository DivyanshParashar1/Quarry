# source-gmail-alerts fixtures

**Synthetic.** These HTML bodies imitate the structure of each portal's alert
email (job title links with tracking parameters, logo links, "View job" buttons,
company/location/salary lines). They were not captured from a real inbox: the
session that wrote the parsers had no access to one.

Before relying on a parser, save a real alert's HTML (Gmail → "Show original",
or `jf gmail alerts --dump <messageId>`) over the matching file here, with any
personal data removed, and adjust the parser's regex/meta rules until
`index.test.ts` passes again.

- `linkedin-security.html` — a non-alert LinkedIn email (must be ignored).
- `linkedin-redesigned.html` — an alert whose template the parser doesn't know
  (must produce a `parse_empty` event, not a crash).
