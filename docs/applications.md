# Applications

Quarry fills and submits application forms with Playwright (Chromium) on Greenhouse, Lever, Ashby,
SmartRecruiters, Workday, SuccessFactors and Taleo. Every submission needs an **approved** application review
item and a live run; a dry run fills the form and screenshots it but never presses Submit.

Requires `pnpm exec playwright install chromium`. Set `BROWSER_HEADLESS=false` to watch.

## Flow

```bash
pnpm quarry apply draft <jobId>          # map the form, upload the chosen resume, screenshot it filled
pnpm quarry apply draft <jobId> --no-preview
pnpm quarry review list                  # check the mapped answers and screenshot
pnpm quarry review approve <id>
pnpm quarry apply send                   # dry run: fills + screenshots only
pnpm quarry apply send --live [--watch]  # submit approved applications
```

On the dashboard: the job page's **Apply** panel, then the **Review** tab. With `MODE=live` the server submits
approved applications every 5 minutes. With autopilot on, the sequencer queues the application draft itself
when a job reaches `ready_to_apply` ([autopilot.md](autopilot.md)).

Each submission is keyed `apply:<jobId>:<profileVersion>`; retrying a completed application is a no-op and
returns the earlier result. Screenshots and the confirmation are stored on the action.

## How answers are filled

1. **Structured fields** (name, email, phone, links, school, degree, current company…) map deterministically
   from `preferences.yaml` → `application`.
2. **Recurring questions** match `application.answers` (substring of the label), then the **answer bank** —
   answers you approved on earlier drafts.
3. **Remaining free-text and factual choice questions** are answered by the LLM, grounded only in
   `facts.yaml`, the JD and your stored answers, with the form's length limits. Each carries a confidence.
4. **Never generated:** salary, notice period, visa/sponsorship, work authorization and EEO/demographics. They
   come from `preferences.yaml` or stay blank, and a blank required field keeps the draft for you.

With `autopilot.autoApproveApplications: true` (off by default), a draft auto-approves only when every LLM
answer clears `autopilot.confidenceFloor.answers` (0.85).

Manage the bank with `pnpm quarry answers [list] | delete <id>` or Profile → answers.

## Account-based ATSs (Workday, SuccessFactors, Taleo)

These need a candidate account per employer tenant. The three actors share one wizard
(`packages/plugin-sdk/src/wizard.ts`):

- **Account.** Created or signed into with your connected Gmail address. The generated per-tenant password
  is stored in the OS keychain, never in the database or logs.
- **Consent.** Terms/privacy agreements are accepted only when the draft's `consent:terms` answer is **Yes** —
  you set it when reviewing.
- **Verification codes / magic links** are read from Gmail: after a step that asks for a code, Quarry polls for
  a message from the ATS domain, extracts the code, and types it. No code within 5 minutes → an *attention*
  item.
- **Dry run** signs in and walks the wizard to the Review step (the ATS may save it as a draft), then stops.
- **Unknown page layout** → the item fails and an *attention* item with screenshots is raised instead of
  guessing. Failed steps are captured to `data/apply-failures/`.
- **Per-tenant overrides** (selectors, question maps) go under `plugins.<actor>.tenants` in `config.yaml`.

SuccessFactors sites hosted on an employer's own domain are out of reach (each plugin's allowed domains are
fixed).

## When something breaks

- The **Health** tab shows apply incidents: repeated failures on one actor pause it for a day and raise an
  attention item ([orchestrator.md](orchestrator.md)).
- Check the screenshots on the review item and `data/apply-failures/`.
- You can always apply by hand and record it: `pnpm quarry pipeline advance <jobId>` from `ready_to_apply`
  marks it applied.
