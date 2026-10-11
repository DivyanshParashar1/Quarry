# JobForge: Phase Plan 15–23 (Full Automation)

> Extends `PLAN.md` and `PLAN-phases-6-13.md`. Current state: Phases 6–13 done, plus the Phase 14 backpressure.
> Goal: the whole loop runs unattended. Each stage emits an event that triggers the next; an hourly
> sweeper (and a run on every server start) catches anything missed while the server was off; an
> orchestrator watches the whole system and fixes it.
>
> Same working rules as `CLAUDE.md`: one phase at a time, tests alongside code, fixtures only in CI,
> stop at phase end for review, no `Co-Authored-By` trailer. **Live runs against real sites are
> batched into the final phase (23)** per user decision (2026-10-09).

---

## Decisions taken with the user (2026-10-09)

| Topic | Decision |
|---|---|
| One-page fit | Step down font size, then line spacing, each to a floor. Still > 1 page → LLM shortens bullet text (guardrailed). |
| LLM rewriting | LLM only writes the **Technical Skills** `.tex`. Input: JD + the assembled resume `.tex` (incl. selected projects' tech-stack lines). Output: skills fragment only. Bullet *content* is never rewritten except the length-only shortening above. |
| Sources | No new sources this round. Nightly discovery **on**. Every board a company uses is fetched. |
| ATS score | New per-ATS resume score checker (parse-emulation + keyword coverage). Used by the selector. |
| Resume selector | Build it: score the library against the JD; below threshold → generate. |
| Contacts import | Any Excel/CSV → EDA → normalised into the contacts format. |
| LinkedIn reach | 1st-degree connections get a direct message; 2nd-degree get a connection request with note. Cold search stays as fallback. LinkedIn connect/login moves into the dashboard. |
| Follow-ups | **24 h** after the ask, on both email and LinkedIn, auto-approved. Hourly cron kept, plus a run on server start. |
| Apply trigger | Referral reply **or** deadline imminent **or** 2-day wait fallback (unchanged). |
| Auto-apply scope | Gmail OTP + LLM free-text answers, SmartRecruiters, Workday, SuccessFactors, Taleo. |
| Orchestrator | Ops actions **and auto-applied code fixes**, inside the guardrails in Phase 22. |

### Where an LLM is used (and nowhere else)
Match rubric (top-K only) · block selection · skills rewrite · bullet shortening (only when the fit loop
runs out of typography room) · referral/follow-up messages · Excel column mapping (only when heuristics
fail) · free-text application answers · deadline inference · company-list extraction · orchestrator
diagnosis and code fixes. Everything else (filters, selector scoring, ATS score, fit loop, sweeper,
state machine, OTP extraction) is deterministic.

---

## Event chain

```
discovery.nightly ─► source.fetch ─► jobs.new ─► match ─► job.matched
   ─► resume.select ──(score ≥ threshold)──► resume.ready
                    └─(below)─► resume.generate ─► fit ─► ats.score ─► resume.ready
   ─► referral.fanout ─► sends (email + LinkedIn) ─► followup (24 h)
   ─► referral.replied | deadline.imminent | wait_elapsed ─► apply ─► applied | failed
any *.failed / stuck state / health check ─► orchestrator
```

Events are written to `events` (as today) **and** enqueue the next pg-boss job, so stages run as soon as
input is ready instead of waiting for the hourly tick. The hourly sweeper re-derives the same work from DB
state, so a missed event only costs latency, never a lost job.

---

## Phase 15 — Resume engine: one-page fit + skills rewrite v2

### Scope
- `plugins/tailor-resume-latex/fit.ts` — deterministic fit loop after assembly:
  1. compile; if pages = 1 → done.
  2. font size steps (`10pt` → `9.5pt` → `9pt`; floor `fit.minFontPt`, default 9) via a preamble hook (`\fontsize` + `\selectfont` in a `%%FIT%%` slot, so `preamble.tex` stays user-owned).
  3. line spacing steps (`\linespread` 1.0 → 0.97 → 0.94; floor `fit.minLinespread`, default 0.94).
  4. still > 1 page → **bullet shortening**: LLM gets the longest N bullets and returns shorter versions; guardrail rejects any rewrite that adds a number, proper noun, or tech term not in the original (reuse the guardrail shape from `RewriteValidation`). Repeat up to `fit.maxShortenRounds` (2).
  5. still > 1 page → `status: overflow`, variant kept but not auto-used; raises a review item.
- Fit result stored on the variant: `fit: { fontPt, linespread, shortenedBullets[], rounds }`.
- `skills.ts` v2 — prompt input becomes **JD + full assembled `.tex`** (so the selected projects' tech-stack lines are visible). Output is still only the skills fragment. Allowed catalogue = original skills items ∪ items in the selected blocks' tech-stack lines (so a skill used in a project can be surfaced even if the skills block missed it); anything else is rejected, as today.
- Drop planned "sub-phase 3" bullet rewrites from the roadmap (superseded by the above).

### Done when
- A 2-page assembly is brought to 1 page by typography alone in a fixture test; a harder one needs shortening, and a shortening that invents a number is reverted.
- Skills rewrite surfaces a tech-stack-only item and rejects an invented one.

---

## Phase 16 — ATS score checker + resume selector

### Scope
- `packages/core/ats-score/` (deterministic, no LLM):
  - Extract text from the compiled PDF (`pdf-parse`, already a server dependency; moved/added to core).
  - **Parse checks**: text extractable, reading order sane, section headers recognised, contact info parsed, no ligature/encoding breakage, dates parseable.
  - **Keyword coverage**: JD skills/requirements extracted deterministically (skill dictionary built from the user's skills + common tech lexicon, plus n-grams with TF-IDF against the job corpus) vs resume text; hard requirements weighted higher.
  - **Per-ATS profile** (`greenhouse | lever | ashby | workday | smartrecruiters | successfactors | taleo | generic`): known quirks weighted per ATS (e.g. Workday/Taleo parse-and-fill sensitivity to section names, date formats, tables/columns; Greenhouse/Lever mostly keyword-search driven). The job's ATS comes from its `company_sources` row.
  - Output `{ score 0–100, parse: {...}, keywords: {matched[], missing[]}, atsType, notes[] }`, stored on `resume_variants.ats_score`.
- **Resume library** = every `rendered` variant (any job) + user base resumes (`profile/resume/base/*.yaml` = a fixed block selection; optional).
- `packages/core/resume-selector.ts`:
  - For a matched job: score each library entry = `w1·embedding cosine(resume text, JD) + w2·ATS score` (defaults 0.4 / 0.6).
  - Best ≥ `selector.threshold` (default 75) → reuse (linked to the job, no LLM call). Otherwise → generate (Phase 15 path) → ATS-score the new variant; if it still scores lower than the best library entry, use the library entry.
- Sequencer/autopilot call the selector instead of `runTailor` directly. Dashboard: ATS score card with missing keywords; selector decision on the job page.
- DB migration: `resume_variants.ats_score jsonb`, `resume_variants.source (generated|reused|base)`, `job_resume (job_id, variant_id, selector_score, decided_at)`.

### Done when
- A JD close to a previous job reuses that variant with no LLM call; a distant JD triggers generation.
- ATS score flags a missing hard requirement and a broken-ligature PDF in fixture tests.

### Revised with the user before implementation (2026-10-09) — supersedes the selector bullets above
- **Resume library = combos generated up front.** Every subset of exactly `resumes.projectsPerResume`
  projects (default 3; experience/education/extras always included) is rendered once, with its Technical
  Skills tailored to *its own projects* (one LLM call per combo, same allowlist as Phase 15) and the
  Phase 15 fit loop. Base resumes (`profile/resume/base/*.yaml`, fixed block selection, original skills)
  are supported; one `base/default.yaml` (all blocks) ships.
- **Resumes page** (new dashboard tab): the library, a "Scrap & regenerate" button (retires every current
  combo/base resume — rows and PDFs are kept so past sends still resolve — then regenerates), and the
  benchmark matrix.
- **Benchmarks:** categories (default *SWE intern* and *AI/ML engineer*, more addable), 5 JDs each
  auto-picked from the jobs DB (title keywords + match score), swappable on the page. Every library
  resume is ATS-scored against every benchmark JD under every ATS profile.
- **Per-job selection (deterministic, no LLM):** each non-retired library resume (any profile version)
  is scored against the job's real JD: `0.4·similarity + 0.6·ATS`, similarity = cosine rescaled
  0.5→0 / 0.9→100. Best wins; benchmark category averages break ties.
- **Per-job tailoring = only the Technical Skills rewrite** on the chosen combo (always, one LLM call),
  then re-fit and re-score; the tailored resume is kept only if its ATS score for that job is ≥ the
  combo's, else the combo is used as-is. `selector.threshold` (75) only flags a weak fit.
- **Manual:** `jf tailor <jobId>` / the job page go through the selector; `--force` / "Generate new"
  re-picks the best combo and reruns the skills rewrite. Full per-job generation (Phase 15 path) runs
  only when the library is empty.
- Done when: combos + base render; benchmarks score them per ATS; a new job picks the best combo with
  no selection LLM call and keeps the tailored version only when its ATS score rises; ATS score flags
  a missing hard requirement and a broken-ligature PDF in fixture tests.

---

## Phase 17 — Referral machine v2: Excel contact import + LinkedIn 1st/2nd degree + dashboard connect

### Scope
- **Contact import** (`jf contacts import <file>`, `POST /api/contacts/import`, dashboard upload):
  - Reads `.xlsx`, `.xls`, `.csv` (new dependency: `exceljs` for xlsx; csv via existing parsing).
  - EDA report: sheets, header row detection, column types, fill rates, duplicates, invalid emails, mixed name formats.
  - Column mapping: deterministic header/value heuristics (email regex, LinkedIn URL, company names matched to `companies`); **LLM fallback** only for columns it can't classify.
  - Fixes: split full names, trim/case-normalise, dedupe by email/LinkedIn URL, map company to existing company (create if unknown), flag rows it can't fix.
  - Preview → confirm (dashboard) or `--yes` (CLI). Imported contacts get `source = manual_import` and rank **first** in fan-out.
- **LinkedIn degree-aware fan-out**:
  - `enricher-linkedin-employees` records connection degree from search results.
  - 1st-degree → new `linkedin_message` channel: direct referral message (actor gains `sendMessage`).
  - 2nd-degree → connection request with note (existing). Rank: imported list → 1st → 2nd → cold email guesses.
  - On acceptance of a 2nd-degree request → queue the full referral message automatically.
- **Dashboard LinkedIn panel**: connect (launches the headed login window on this machine, saves the encrypted session), status/health, pause/resume, daily usage vs cap.
- Message caps: `linkedin.dailyMessageCap` (default 50) alongside the existing 25 connection requests/day.

### Done when
- A messy real-world-shaped Excel fixture (merged headers, mixed columns, dupes) imports cleanly with a correct EDA report.
- Fan-out for a job with 1st- and 2nd-degree contacts sends a message to the former and a request to the latter (fake browser).

### Revised with the user before implementation (2026-10-11) — supersedes the LinkedIn bullets above
- **No LinkedIn automation for outreach** (priority: never risk the account). The official LinkedIn API
  can't read connections (closed to non-partners since 2015), so connections come from the user's
  **Connections CSV export**. Fan-out never uses the automated LinkedIn actor; its code stays behind
  `LINKEDIN_ENABLED` (default off). No dashboard LinkedIn login panel.
- **Contact import** (`.xlsx` via `exceljs`, `.csv`; `.xls` rejected with "Save As .xlsx"): recognises the
  LinkedIn export exactly (contacts marked 1st-degree, `source = linkedin_export`) and arbitrary hand-made
  lists (`source = manual_import`); EDA report, deterministic mapping, LLM only for unclassifiable columns;
  preview → confirm.
- **Manual LinkedIn channel**: connections at the job's company get a full tailored message (name, role,
  one resume bullet, job link; the tailored resume PDF to attach by hand); other contacts with a profile
  URL but no usable email get a ≤300-char connection-request note. The user sends them; the dashboard
  offers Copy / Open profile / Download PDF / **I sent it** / **They replied**, which feed the cooldown,
  batch counts, apply trigger and follow-ups. Approval = the same confidence gate as email asks.
- Ranking: imported contacts → connections → others.
- Done when: a messy Excel fixture and a LinkedIn-export fixture import cleanly with a correct EDA report;
  a fan-out for a job with a connection, a non-connection with only a LinkedIn URL, and an emailable
  contact drafts a message, a note and an email respectively; marking sent/replied updates the batch.

---

## Phase 18 — Sweeper, 24 h follow-ups, event triggers, discovery on

### Scope
- `packages/core/sweeper.ts` — one idempotent pass, run **on server start** and **hourly**:
  board fetch (only boards whose last fetch > `sweeper.fetchEveryHours`, default 6) · alerts · embed + match pending · selector for matched jobs · fan-out · follow-up drafting · reply tracking (email + LinkedIn) · deadline inference/expiry · sequencer tick · apply tick.
  Under a lease, so overlapping runs are harmless.
- Follow-ups: `outreach.followupDays: [1]` (24 h), **auto-approved** when draft confidence ≥ floor (same gate as asks); LinkedIn follow-up = message to 1st-degree / accepted contacts with no reply after 24 h. A pending (unaccepted) request gets no reminder.
- Event triggers: stage completion enqueues the next stage (`jobs.new` → match, `job.matched` → select, `resume.ready` → fan-out, `referral.replied`/`deadline.imminent` → apply).
- `discovery.nightly: true` in `config.yaml`; recheck keeps adding boards rather than replacing; all active boards per company are fetched.
- Autopilot cron stays hourly but becomes the sweeper.

### Done when
- Simulated restart after "3 days off" catches up all due follow-ups/transitions in one pass, with no duplicates.
- A new job flows source → resume.ready → fan-out without waiting for a cron tick.

### Revised with the user before implementation (2026-10-11)
- Follow-ups: **one**, 24 h after the ask (`followupDays: [1]`, `maxFollowups: 1`). Email follow-ups are
  auto-approved under the same gate as asks; LinkedIn follow-ups are drafts the user sends by hand
  (Phase 17), only for sent *messages*. A sent connection *note* gets no reminder; a **"They accepted"**
  button drafts the full referral message (with resume) for the user to send, and that message gets the
  24 h follow-up.
- The sweeper's free steps (board fetch, alerts, reply tracking, deadline expiry) always run on server start
  and hourly; LLM-spending steps (match, resume selection, fan-out, follow-up drafting, deadline inference)
  run only with `autopilot.enabled: true`; sends still need `MODE=live`.
- `discovery.nightly` defaults to true (code + config.example.yaml); the user's config.yaml can turn it off.

---

## Phase 19 — Auto-apply: Gmail OTP, LLM free-text answers, SmartRecruiters

### Scope
- `packages/core/otp.ts` — after a submit/sign-in step that asks for a code, poll Gmail (read scope) for messages from the ATS domain received after the step started; extract the code with per-ATS + generic regexes (and magic links); timeout 5 min → `attention` item.
- Free-text answers: LLM answers grounded in `facts.yaml` + JD + `application.answers` (reused answers first); length limits from the form; answers stored on the draft with `source: llm` and confidence; low confidence → stays pending for review.
- `plugins/actor-apply-smartrecruiters` — hosted apply form, same contract as Greenhouse/Lever/Ashby.
- `mapAnswers` stays deterministic for structured fields.

### Done when
- Fixture flows: OTP email arrives → code typed → submission confirmed; a free-text question is answered and an invented fact is rejected.

### Decided with the user before implementation (2026-10-11)
- The LLM answers unanswered **free-text and choice** questions (text/textarea, and select/radio with a factual
  basis), grounded only in facts.yaml + the JD + `application.answers`. **Never** EEO, work authorization,
  sponsorship, salary or notice period (those come from preferences.yaml or stay blank).
- **Answer bank**: answers the user approves are stored and reused first for similar questions (editable on the
  Profile page); preferences.yaml answers still win.
- Auto-approval (only when `autoApproveApplications` is on): a draft with LLM answers is auto-approved only when
  every LLM answer's confidence ≥ 0.85; otherwise it waits for review.
- SmartRecruiters: one real public posting is inspected read-only (nothing submitted) and saved as a fixture.

---

## Phase 20 — Workday apply

### Scope
- `plugins/actor-apply-workday`: per-tenant account create/sign-in (email verification via Phase 19 OTP/magic-link), multi-step wizard (My Information → Experience → Application Questions → Voluntary Disclosures → Self Identify → Review), resume upload with Workday's autofill then correction, per-step screenshot.
- Credentials: one generated password per tenant in the OS keychain (never in DB/events).
- Tenant quirks captured as per-tenant config overrides (selectors/question maps) learned from failures (feeds Phase 22).

### Done when
- Fixture runs of two differently-configured tenants reach the review step; dry run never clicks final submit.

### Implementation notes (2026-10-11)
- The wizard pages are synthetic fixtures (Workday `data-automation-id` conventions); only the public postings were
  recorded — opening the real apply flow was not done (it needs an account). Phase 23 verifies the selectors.
- A dry run of an *approved* draft does sign in / create the tenant account and walks to Review (Workday saves the
  in-progress application as a draft); it never presses Submit. No preview at draft time (no account before approval).
- The account email is the connected Gmail address (verification emails must be readable).

---

## Phase 21 — SuccessFactors + Taleo apply

### Scope
- `plugins/actor-apply-successfactors` and `plugins/actor-apply-taleo`: account flows via Phase 19 OTP, wizard fill, per-tenant overrides. Best effort; unknown layouts → `attention` item with screenshots instead of guessing.

### Done when
- Fixture runs reach review for one tenant each; unknown layout raises attention cleanly.

---

## Phase 22 — Orchestrator (multi-expert supervisor)

### Scope
- `packages/orchestrator` + `orchestrator` pg-boss loop (every 15 min) and triggers on `*.failed` events / stuck states.
- **Monitor (deterministic)**: health checks per stage — error streaks per board/plugin, stuck pipeline states (> N h), queue depth, send/bounce/reply rates, LinkedIn health, LLM spend vs `orchestrator.dailyLlmBudgetUsd`, review backlog.
- **Experts (LLM, invoked only on a failed check)**, each with a narrow toolset:
  - *Sources* (board errors, drift, zero-posting boards), *Outreach* (bounces, deliverability, reply-rate drops), *Apply* (form failures, selector drift), *Resume* (fit overflow, low ATS scores), *Ops* (queues, DB, LLM budget).
  - Router picks the expert from the failing check; each returns a structured plan of actions.
- **Ops actions** (no code): retry/requeue, pause/resume a board or plugin, adjust config within bounds, re-run a stage, expire/advance a job, top up a referral batch, raise an `attention` item.
- **Code fixes (auto-applied, user-approved)**: Claude Code CLI in a git worktree on `orchestrator/fix-<id>`:
  1. reproduce with a recorded fixture of the failure (saved by the failing plugin);
  2. patch; must pass `pnpm typecheck`, `pnpm lint`, full `pnpm test`, plus the new reproducing test;
  3. merge to `main` (commit message names the incident, no AI trailer), restart workers;
  4. watch the affected stage for `orchestrator.verifyWindowMin`; regression → automatic `git revert` + restart + attention item.
  **Protected paths it may never modify** (patch rejected): review/approval gating and `ApprovedDraft` minting, `dryRun`/`MODE` handling, rate limiters and send caps, cooldowns, LinkedIn gate/pause/health, session store, secrets/env loading, robots.txt handling, the orchestrator's own guardrails, `CLAUDE.md`.
  Max `orchestrator.maxCodeFixesPerDay` (default 3); a second failed fix for the same incident escalates to you.
- **Never automated**: captcha / checkpoint / login walls (LinkedIn or any portal) — pause + notify only.
- Incident log (`incidents` table) + dashboard **Health** tab: open incidents, actions taken, patches merged/reverted, LLM spend.
- Notifications: `attention` items plus optional push (ntfy/Pushover webhook) for human-only problems.

### Done when
- Injected faults (a board returning 404s, a selector change in an apply fixture, a stuck pipeline state, LLM budget exceeded) are each detected, routed to the right expert, and resolved — the selector change via an auto-merged patch, and a deliberately bad patch auto-reverted.

---

## Phase 23 — Live verification (last, per user)

Run each integration once against the real world, re-record fixtures from the real responses, and fix
what breaks: SmartRecruiters / SuccessFactors / Taleo / Ashby / alert-email sources · discovery lists ·
LinkedIn (dedicated account: search, request, message, tracking) · Gmail send/track/OTP · deadline
inference · one real application per ATS · one full unattended day with the orchestrator on.

---

## New dependencies (to note per `CLAUDE.md`)
- `exceljs` (Phase 17) — xlsx reading; nothing in PLAN §2 covers spreadsheets.
- `pdf-parse` moves into `packages/core` (Phase 16) — already used by the server.

## Order
**15 → 16 → 17 → 18 → 19 → 20 → 21 → 22 → 23**, stopping for review after each.
