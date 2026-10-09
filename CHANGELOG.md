# Changelog

## [Phase 0] — Scaffold

- pnpm monorepo with workspaces (`apps/*`, `packages/*`, `plugins/*`).
- TypeScript strict (NodeNext, ES2023), ESLint flat config, Prettier, Vitest.
- `docker-compose.yml` with `pgvector/pgvector:pg16`.
- `packages/db` — Drizzle schema for `companies`, `company_sources`, `jobs`, `raw_postings`, `plugin_runs`, `events`; migrator that enables the `vector` extension.
- `packages/shared` — zod-validated env loader (`loadEnv`), pino logger, typed error classes.
- `packages/plugin-sdk`, `packages/core`, `packages/llm`, `packages/embeddings` — type stubs so workspace imports are stable before Phase 1 fills them in.
- `apps/server`, `apps/cli`, `apps/mcp`, `apps/web` — scaffolds.
- `.env.example`, `.gitignore`, `.nvmrc` (Node 22), `CLAUDE.md`.

## [Phase 1] — Spine + first sources

- `packages/plugin-sdk` — full plugin contract: manifest schema (exact-host domain allowlist, semver, actors must be `external`), `PluginContext`, `RawPosting` zod schema, all six stage interfaces, branded `ApprovedDraft`, `HttpError`/`DomainNotAllowedError`, `decodeEntities`; `@jobforge/plugin-sdk/testing` with `fixtureHttp` so plugin tests never touch the network.
- `packages/core`
  - `DomainRateLimiter` / `TokenBucket`: one FIFO token bucket per host, shared across plugins; the stricter limit wins.
  - `createScopedHttp`: allowlist enforced on every redirect hop, https only, timeouts, retry with exponential backoff + `Retry-After` on 408/425/429/5xx, no retry on other 4xx.
  - `loadPlugin` / `PluginRegistry` / `buildContext`: manifest, stage-method and config validation; plugins get only the scoped context.
  - Normalizer: HTML→markdown, title/company/location normalization, seniority heuristic, placeholder-location filtering, sha256 fingerprint (company + title + primary location).
  - `runSourceTarget`: fetch → validate → normalize → dedup upsert → close stale jobs, with `plugin_runs` and `events` rows; never throws for plugin failures.
  - pg-boss `source.fetch` queue: one job per board; permanent failures (e.g. 404 board) complete without retry.
- `packages/db` — migration `0001` (`raw_postings.company_source_id`, `last_seen_at`, indexes); repositories (`upsertCompany`, `upsertCompanySource`, `listSourceTargets`, `recordPosting`, `closeStaleJobs`, `listJobs`, `countJobs`, plugin run + event helpers); `createDb`, `runMigrations`; test helpers that clone a migrated template DB per test file.
- `plugins/source-greenhouse` (2 req/s) and `plugins/source-lever` (1 req/s per Lever's robots.txt `Crawl-delay`), coded against recorded fixtures.
- `apps/cli` — `jf companies import <csv> [--skip-invalid]`, `jf companies list`, `jf fetch [--plugin] [--company] [--concurrency]`, `jf jobs list [--company] [--q] [--limit] [--all]`; root `pnpm jf …` script.
- `apps/server` — hosts the `source.fetch` workers with graceful shutdown.
- `data/companies.seed.csv` — 49 boards (40 Greenhouse, 9 Lever) verified against the live APIs.
- Fixes to Phase 0: missing `@eslint/js` dev dependency (lint was failing), root `"type": "module"`.
- Acceptance run (live, 50 boards incl. one dead token): 49/50 ok in ~31s, 9,629 postings → 9,443 canonical jobs; rerun produced 0 new / 0 closed.

## [Phase 2] — LLM layer, profile, matching, review UI

- `packages/llm` — provider-agnostic `LLMClient` (contract in `@jobforge/shared`): per-task routing (`LLM_PROVIDER` default + `config.yaml` overrides), zod-validated structured output with one repair retry, one `llm_calls` row per call.
  - Claude Code CLI adapter: `claude -p --output-format json --json-schema … --permission-mode dontAsk` (never `--bare`), prompt on stdin, empty temp cwd, concurrency cap, timeout + kill, `structured_output`/usage/`total_cost_usd` parsing; `checkClaudeCli` uses `--version` + `auth status` (no model call).
  - OpenRouter adapter: `response_format: json_schema` with `require_parameters`, falls back to JSON-only prompting per model when rejected; reports usage cost.
  - Contract tests run every adapter with its transport faked (fake CLI script, fake fetch); `pnpm --filter @jobforge/llm smoke` for real providers.
- `packages/embeddings` — `bge-small-en-v1.5` via `@huggingface/transformers` (CLS pooling, normalized, 384 dims), bge query prefix for the profile; deterministic hash embedder for tests.
- `packages/db` — migration `0002`: `jobs.embedding vector(384)` (HNSW, cleared when the description changes), `profile_facts` (stable YAML ids, version bump on change, retired not deleted), `profile_snapshots` (content-hash versions), `match_results` (per job × profile version, method `llm|prefilter|filtered`), `llm_calls`; repositories for profile sync, embeddings, ranked listing, job detail, stats.
- Profile — `profile/facts.yaml` + `preferences.yaml` schemas (roles, seniority, locations, remote policy, stack, salary floor, experience years, graduation year, exclusions, notes); `jf profile load|show`.
- `plugins/matcher-default` — hard filters (exclusions, seniority, location/remote, graduation batch, years of experience) → cosine prefilter (`minSimilarity`, `llmTopK`) → batched LLM rubric (stack/seniority/location/eligibility 0–10, score 0–100, reasons, concerns). Jobs the model omits or whose batch fails are left for the next run.
- `packages/core` — context injects the LLM only for plugins declaring `permissions.llm`; `loadProfile`, `embedPending`, `runMatch` (resumable, idempotent per profile version, `plugin_runs` + `events`).
- `plugins/source-ashby` — public posting API, 2 req/s, skips unlisted postings (fixture is synthetic; see its README).
- `apps/server` — Fastify read-only API (`/api/jobs`, `/api/jobs/:id`, `/api/stats`, `/api/profile`, `/api/companies`) on 127.0.0.1, serves the built dashboard, runs source workers.
- `apps/web` — Vite + React + TanStack Query + Tailwind (shadcn-style components): ranked job list with views (Ranked/All/Unscored/Excluded) and filters kept in the URL; job detail with score, rubric bars, concerns, provider/model, description.
- CLI — `jf embed`, `jf match [--rescore] [--limit] [--no-embed]`, `jf llm check`; `jf jobs list` sorts by score.
- `config.example.yaml`; root scripts `pnpm server`, `pnpm web:dev`, `pnpm web:build`.
- Fix: `pnpm db:migrate` now reads the root `.env`.

## [Phase 3] — Outreach

- `packages/db` — migration `0003`: `contacts`, `review_items` (pending → approved → executed; rejected/failed/cancelled), `actions` (unique idempotency key), `outreach_threads`, `app_state`; company mail domain/MX/pattern columns; repositories incl. send-cap queries and a lease lock.
- `packages/plugin-sdk` — `DnsResolver` and `GmailHandle` capabilities (`permissions.dns`, `permissions.gmail` scopes), `Company` with contacts, `CompanyEnrichment`, `OutreachActionInput`, `EmailDraft` schemas, typed `ActorPlugin<C, I, D, R>`; `fakeGmail` and an RFC 5322 parser for tests.
- `packages/core`
  - Capabilities injected only when declared; Gmail narrowed to the declared scopes; cached MX resolver; rate-limited Gmail client and OAuth helpers (`@googleapis/gmail`).
  - `enrichContacts` (persists mail domain, pattern, inferred addresses; never overwrites manual ones).
  - Outreach engine: `draftOutreach`, `editDraft`, `approveReviewItem` / `rejectReviewItem`; only the core mints an `ApprovedDraft`, from an approved row. `runSendTick`: dry run previews; live sends one email per tick under a lease, enforcing the daily cap (20), 2 people/company/7 days (explicit per-item override), randomized spacing, a status re-check right before sending, and 3 attempts before failing. `draftDueFollowups` (max 2, 5 then 7 days), `pollTracker` (reply → thread replied, follow-ups cancelled, address confirmed; bounce → contact bounced). pg-boss schedules for these loops (send loop only in `MODE=live`).
- `plugins/enricher-contacts-pattern` — pattern inference from trusted known addresses with priors fallback (≤ 40% confidence), bounce evidence, MX gate, no SMTP probing.
- `plugins/actor-gmail-outreach` — grounded LLM drafts (placeholder/length checks drive the repair retry, unknown fact ids dropped, signature appended, follow-ups in-thread); plain-text MIME with CR/LF-stripped headers and a Message-ID derived from the idempotency key; a retry searches Sent first and never resends.
- `plugins/tracker-gmail` — read-only inbox poll classifying replies and bounces, ignoring auto-replies.
- `apps/cli` — `jf gmail auth|status` (loopback OAuth with state check; refresh token written to `.env`, mode 600), `jf contacts add|list|enrich`, `jf review list|show|edit|approve|reject`, `jf outreach draft|send [--live] [--watch]|followups|track|threads`; id prefixes accepted.
- `apps/server` — review/contacts/outreach/pipeline/company/source/profile-fact endpoints; loopback-host check and `x-jobforge` + same-origin requirement for writes (DNS-rebinding and CSRF guards).
- `apps/web` — Review tab (edit, save, approve with confirmation, company-cap override, reject/cancel) and per-job Outreach panel (contacts, add, find emails, draft).
- `apps/mcp` — MCP server over stdio with the PLAN §6 tools (minus `discover_ats`, Phase 5) plus `add_contact`, `find_emails`, `draft_outreach`; `approve` is destructive-annotated and confirms via elicitation; `.mcp.json`.
- `profile_update_fact` edits `facts.yaml` in place, keeping comments.
- `docs/outreach.md` — Gmail setup and the draft → approve → send → track flow.

## [Phase 4] — Tailoring

- `packages/db` — migration `0004`: `resume_variants` (bullets, header, validation report, PDF path, status `rendered | validation_failed | render_failed`, provider/model); `resume-repo.ts` with `insertResumeVariant`, `getResumeVariant`, `listResumeVariantsForJob`, `latestRenderedResumeForJob`.
- `packages/plugin-sdk`
  - `tailor.ts` — `TailoredResume` / `TailoredBullet` / `TailoredHeader` zod schemas, `FactValidation` + `ValidationIssue` for the grounding report; `TailoredArtifacts = TailoredResume`; `defineTailorPlugin` helper.
  - `outreach.ts` — `EmailAttachment` schema and an `attachments` field on `EmailDraft` / `OutreachActionInput`; patch schema accepts attachment edits.
- `plugins/tailor-resume-typst`
  - LLM prompt asks for ≤ `maxBullets` grounded bullets, each citing a fact id, with a 1-2 sentence summary and headline skills.
  - Validator (PLAN.md §7): drops any bullet whose fact id is unknown or that introduces proper terms or numbers not present in the source fact's `content`/`metrics`/`tags`; strips header skills that aren't in the profile; flags long bullets as warnings but keeps them.
- `packages/core/tailor-runner.ts` — `runTailor({jobId})`: resolves job + active profile, runs the plugin, writes `plugin_runs`/`events`, inserts a `resume_variants` row. Renders the Typst template (`templates/resume.typ`) to `data/resumes/<hash>.pdf` by spawning `typst compile`; a missing/failing binary records `render_failed` with a clear error so the bullets + report are still available. `checkTypst()` helper probes the binary.
- `plugins/actor-gmail-outreach`
  - `buildMime` now emits `multipart/mixed` with one base64 part per attachment when `EmailDraft.attachments` is non-empty; falls back to plain-text otherwise.
  - `execute()` reads attachment bytes from disk at send time (never over the DB boundary); dry-run logs the filenames.
- `packages/core/outreach.ts` — `draftOutreach` auto-attaches the latest `rendered` resume variant for the job via `resolveResumeAttachment`; follow-ups do not re-attach.
- `apps/cli` — `jf tailor <jobId>` (id-prefix accepted) runs the tailor and prints the status, kept/dropped counts, dropped-bullet details, and the PDF path. Checks for `typst` up-front and warns if missing.
- `apps/server`
  - Routes: `POST /api/jobs/:id/tailor`, `GET /api/jobs/:id/resume-variants`, `GET /api/resume-variants/:id`, `GET /api/resume-variants/:id/pdf` (streams the PDF under the loopback + CSRF guards; writes still require `x-jobforge`).
  - `runtime.ts` grows `lazyTailorDeps` (shares the LLM client and plugin registry with outreach); `index.ts` wires it in.
- `apps/web` — `ResumePanel` on job detail: "Tailor for this job" / "Retailor" button, status badge, bullets grouped by section with their fact-id citations, header summary + skill chips, expandable validation report, and a link to open the PDF; older variants collapse into a `<details>`.
- `apps/mcp` — adds `tailor_resume(jobId)` and `list_resume_variants(jobId)` tools (both non-destructive; tailor isn't on the `approve` path, so no elicitation).
- `packages/shared/app-config.ts` — new `resume: { name, contact, headline }` section (defaults empty) rendered into the Typst header; never auto-invented.
- `.gitignore` — `data/resumes/` kept out of the tree.

Dependencies: no new third-party packages; `typst` is required at runtime (not at build/test time — tests skip the PDF-render assertion when the binary isn't on PATH).

## [Phase 4.5] — LaTeX swap and LLM-in-the-loop autopilot

- **Resume renderer swapped from Typst to LaTeX.**
  - Deleted `plugins/tailor-resume-typst` and `templates/resume.typ`.
  - New `plugins/tailor-resume-latex` (same grounded-bullet validator; prompt now also asks the LLM to self-report a confidence 0..1 and the plugin penalises it per dropped/warned bullet).
  - New `templates/resume.tex` based on Jake Gutierrez's one-page CV template; renderer fills `%%NAME%%`, `%%CONTACT%%`, `%%SUMMARY%%`, `%%SKILLS%%`, `%%SECTIONS%%` placeholders with LaTeX-escaped bullets grouped by section.
  - `packages/core/tailor-runner.ts`: `renderPdf` now spawns `latexmk -pdf -interaction=nonstopmode -halt-on-error -silent`; `escapeLatex` and `fillLatexTemplate` are exported. `checkTypst` → `checkLatex`, `TYPST_BIN` → `LATEX_BIN`, `DEFAULT_TAILOR = 'tailor-resume-latex'`, template id `'jakes-resume'`.
  - CLI `jf tailor` + MCP tools now reference LaTeX.
- **Confidence scores.** Migration 0005 adds `confidence real` to `match_results`, `resume_variants`, and `review_items`, plus `review_items.decided_by text`. Matcher, tailor, and outreach-actor LLM schemas each include a self-reported `confidence` 0..1. `EmailDraft.confidence` carries it from `prepare` into the review item.
- **Autopilot** (`packages/core/src/autopilot.ts`):
  - Walks top-ranked LLM-scored jobs, enforces deterministic + confidence gates in sequence:
    1. `match_confidence >= floor.match` and `score >= minMatchScore`
    2. no open outreach for the company's contacts and no prior thread
    3. a `rendered` resume variant for the active profile (reused if present, else `runTailor`), with `tailor_confidence >= floor.tailor` and zero validator errors
    4. an active contact with `email_confidence >= minEmailConfidence`
    5. company cap `perCompanyPerWeek` (if already at limit, escalate to human)
    6. `draftOutreach` succeeds and `draft_confidence >= floor.outreach`
    7. autopilot's own `maxAutoApprovesPerDay` budget still has room
  - Items that pass all floors are transitioned `pending → approved` with `decided_by='autopilot'` and a composite confidence; the send loop handles the actual email per MODE=live. Items that fail any floor stay pending for human review (user ask: "only confused jobs go to review"). Each decision is logged with a reason + note.
- **Config.** New `autopilot: { enabled, minMatchScore, confidenceFloor: {match, tailor, outreach}, minEmailConfidence, maxAutoApprovesPerDay, candidateBatch }` with conservative defaults (disabled; 0.75/0.75/0.8 floors; 10 approves/day).
- **CLI.** `jf autopilot [--limit <n>] [--live]` prints a per-job decision table.
- **Server.** `POST /api/autopilot/run` + lazy deps; when `autopilot.enabled && MODE=live`, the server registers an hourly pg-boss cron (`autopilot.hourly`).
- **MCP.** New `run_autopilot(limit?)` tool; still non-destructive (auto-approval honours the server's dry-run gate).
- **DB.** `autopilotApprovesSince`, `transitionReviewItem` accepts `decidedBy` and `confidence`.

Dependencies: no new third-party packages; `latexmk` (TeX Live) is required at runtime for PDF rendering. Tests pre-insert a rendered variant so they don't depend on a local LaTeX install.

## [Phase 5] — Profile editor and LLM "fix" (web UI)

- `packages/shared/profile-files.ts` — `deleteFactInFile` and `writePreferencesFile` round out the YAML writers that preserve top-level comments.
- `apps/server/src/routes-profile.ts` — full profile REST surface:
  - `GET /api/profile/full` returns facts + preferences.
  - `POST /api/profile/facts` creates (body contains id); `PATCH /api/profile/facts/:id` updates; `DELETE /api/profile/facts/:id` removes. Every write re-runs `loadProfile` so the derived DB stays in sync in one request.
  - `PUT /api/profile/preferences` overwrites `preferences.yaml` after schema validation.
  - `POST /api/profile/fix` — one-shot LLM rewrite of any text snippet, with a guard-rail system prompt that forbids inventing facts.
  - `POST /api/profile/import` — multipart PDF upload (10MB cap); `pdf-parse` extracts text, LLM returns up to 40 structured fact drafts the UI stages for per-row confirmation. Nothing is persisted until the user POSTs the fact.
- `apps/server/src/runtime.ts` grows `lazyLLM`; `apps/server/src/api.ts` registers `@fastify/multipart` and mounts the profile routes.
- `apps/web`
  - `/profile` route with three tabs: Facts (grouped by kind, inline create/edit/delete, metrics as JSON), Preferences (lists + salary floor + exclusions + notes), Import (upload PDF → preview drafts → save selected).
  - `FixableField` — Input/Textarea + sparkle button that calls `/api/profile/fix` and replaces the current value with the LLM's tightening pass. Reused throughout the profile editor.
  - `ResumePanel` now renders a 24rem inline PDF iframe for the latest rendered variant.
  - `send()` learns `DELETE`; new `upload()` helper for multipart.
- The redundant `PUT /api/profile/facts/:id` previously living in `routes-outreach.ts` is removed; the MCP server already hits that endpoint via a method that `PATCH` now serves.

Dependencies added (apps/server): `@fastify/multipart ^9`, `pdf-parse ^1.1.1`, `@types/pdf-parse ^1.1.4`. These are server-only and the only sensible path for user-uploaded PDFs; noting the three outside PLAN.md §2.

## [Phase 5.5] — Block-based resume tailor (sub-phase 1: content + deterministic assembler)

Pivot away from fact-grounded resume generation. The LLM no longer authors bullets from `facts.yaml`; instead the user keeps a library of hand-written LaTeX fragments and the tailor only (a) selects which blocks to include per job and (b) rewrites individual bullets when they lack impact for the JD. LaTeX structure is never regenerated.

- `profile/resume/` — new source of truth for resume content:
  - `preamble.tex` — Jake-template preamble + custom commands, extracted verbatim from `my_resume.tex`.
  - `blocks/*.tex` — one self-contained fragment per experience, project, education entry, skills group, and extracurricular (nine blocks total).
  - `manifest.yaml` — declares section wrappers (`\section{...}` + `\resumeSubHeadingListStart` etc. per section), block metadata (section, tags, bullet ids, tech-stack line), budget rules (min/max blocks per section, bullet-count hint).
- `packages/plugin-sdk/src/tailor.ts` — fully replaced schema:
  - `resumeManifestSchema` + `BlockMeta`/`BulletMeta`/`SectionWrapper`/`Budget` zod shapes mirror the YAML.
  - `TailorSelection` carries `included_block_ids` (priority-ordered), `bullet_rewrites`, `tech_stack_rewrites`, `skills_reorder`, `rationale`, `confidence`.
  - `RewriteValidation` + `GuardrailIssue` replace the fact-grounded validator shape; guardrail compares a rewrite to its original bullet (no fact lookup).
  - `TailoredResume` now returns the assembled `.tex` string, compiled PDF bytes, page count, selection, report, status, and provider metadata — the plugin owns rendering.
- `plugins/tailor-resume-latex/` — rewritten end-to-end:
  - `manifest-loader.ts` — reads `profile/resume/manifest.yaml`, validates every referenced fragment exists, loads them into memory.
  - `assembler.ts` — groups selected blocks by section, applies rewrites via exact-string replace against each fragment, emits sections in manifest order with per-section wrappers and inter-block separators.
  - `compile.ts` — `latexmk -pdf -interaction=nonstopmode -halt-on-error` in a temp dir, returns PDF bytes + parsed page count from the log.
  - `index.ts` — Phase 1 is deterministic: pick every manifest block in declared order, no LLM calls. LLM-driven selection + bullet polish land in sub-phase 2.
  - `assembler.test.ts` — verifies the deterministic output matches `my_resume.tex` modulo whitespace, that bullet rewrites apply by string replace, and that `applySkillsReorder` preserves dropped items at the tail.
- `packages/core/src/tailor-runner.ts` — slimmed from 373 to 185 lines; the plugin now assembles + compiles, the runner only persists. The old `escapeLatex`/`fillLatexTemplate` placeholder path is gone. Legacy DB columns (`fact_ids`, `bullets`, `header`) are temporarily reused as metadata carriers (`selectedBlockIds`, `rewrites`) until a sub-phase 2 migration formalises the schema. `templates/resume.tex` is retired.
- `apps/web/src/components/ResumePanel.tsx` + `apps/web/src/lib/api.ts` — `ResumeVariant` reshaped: shows selected block ids as badges, bullet-rewrite diffs under a disclosure, and the guardrail report; keeps the inline PDF viewer.
- `apps/cli/src/index.ts` — `jf tailor` prints `<N> blocks · <M> bullet rewrites` instead of the old "bullets kept / dropped" counters.
- Tests: `tailor-runner.db.test.ts` now uses a stub tailor plugin returning a fixed `TailoredResume`; `autopilot.db.test.ts` pre-inserts a rendered variant in the new shape. 199 tests pass.

Dependencies added (plugins/tailor-resume-latex): `yaml ^2.9.1` (manifest parsing), `tsx ^4` (dev-only).

Next sub-phases: (2) LLM selector picks blocks per JD within budget + shrink-loop verify ≤ 1 page; (3) LLM bullet-rewrite pass with guardrail revert-on-invented-content; (4) DB migration drops legacy `fact_ids`/`bullets`/`header` from `resume_variants` and adds a read-only `/applications` audit page.

## [Phase 5.5] — Block-based resume tailor (sub-phase 2: web editor + LLM selector + skills rewrite)

User-visible shift: the resume is now editable from the dashboard. Each section (experience, projects, …) is a list of hand-written LaTeX blocks the user manages in-app; the LLM only decides which blocks to include for a given job and, as the sole exception, regenerates the "Technical Skills" fragment with new ordering/filtering. No bullet-level rewrites yet — those stay on hold until a later sub-phase.

- **Server** (apps/server):
  - `resume-files.ts` — safe read/write for `profile/resume/manifest.yaml` + `blocks/*.tex`. Block ids are regex-validated (`^[a-z0-9][a-z0-9._-]{0,63}$`), file paths are confined to `<resumeDir>/blocks/`, every write re-validates the manifest against the plugin-sdk schema before touching disk, and YAML comments are preserved via `parseDocument`.
  - `routes-resume.ts` — `GET /api/resume` (manifest + fragments), `POST /api/resume/blocks` (create), `PUT /api/resume/blocks/:id` (update), `DELETE /api/resume/blocks/:id` (removes fragment file too), `PUT /api/resume/order/:section` (reorder within a section).
  - `api.ts` + `index.ts` — register the resume routes and auto-discover `profile/resume/` under the repo root.
- **Web** (apps/web):
  - New `/resume` tab (fourth after jobs/review/profile) rendering `ResumeEditor.tsx` — left sidebar lists sections from `manifest.sections_order` with block counts, right pane shows block list + a form for the selected block (id, title, tags, bullet ids, tech-stack line, always-include, raw LaTeX textarea). Create / Save / Delete all go through the REST surface.
  - `lib/api.ts` gets `ResumeManifest`, `ResumeBlock`, `ResumeData`, etc.
- **Plugin** (plugins/tailor-resume-latex):
  - `selector.ts` — LLM pass that returns `included_block_ids` + rationale + confidence. `enforceRules()` clamps the result against the manifest: unknown ids dropped, duplicates removed, `always_include` blocks force-prepended per section, per-section counts clamped to `budget.{experience,project}_blocks.{min,max}`, result ordered by `sections_order` with the header block first. Bad LLM output can't produce an invalid resume.
  - `skills.ts` — second LLM pass that regenerates only the Technical Skills fragment. Returns raw LaTeX directly (per user ask) but is gated by `validateSkillsLatex`: requires `\begin{itemize}...\end{itemize}` wrapper, only allows commands from a strict allowlist (`begin, end, small, item, textbf, textit, \\`), rejects any forbidden token (`\input`, `\include`, `\write`, `\def`, `\catcode`, `\@`, `\verb`, `\url`, `\href`, …), and refuses any item not present in the original catalogue (so the LLM can never invent a skill). Rejected rewrites fall back to the original fragment and log a warning.
  - `assembler.ts` grows a `fragmentOverrides` field that replaces a block's fragment wholesale — used to apply the LLM-regenerated skills section while leaving every other block exactly as the user wrote it.
  - `compile.ts` adds `-no-shell-escape` to the latexmk invocation. LLM-produced LaTeX can no longer invoke `\write18` even if a crafted fragment slipped past the validator.
  - `index.ts` config: `mode: 'deterministic' | 'llm'` (default `llm` now; deterministic kept for tests), `tailorSkills: boolean` (default true). The provider string on the stored variant becomes `llm+skills` when the skills pass actually took effect.
- **Tests**: 16 new unit tests covering selector hard rules (header, always_include, budget clamp, unknown-id drop), skills validator (invented-item reject, forbidden-token reject, unknown-command reject, missing-wrapper reject), and resume-files writers (create, update, delete, reorder, id validation, unknown section). 215/216 total pass.
- **Dependencies**: `yaml` added to `apps/server`. No new third-party packages elsewhere.

Deferred to sub-phase 3+: compile-and-shrink loop for 1-page enforcement; LLM bullet rewrites with the per-bullet guardrail; DB migration retiring the legacy `fact_ids`/`bullets`/`header` columns; `/applications` audit page.

## [Phase 6] — GCC sources: Workday + SmartRecruiters + tenant discovery

- `packages/plugin-sdk`
  - Manifests accept a leading-label wildcard host (`*.myworkdayjobs.com`); `hostAllowed()` is the single matcher used by ScopedHttp and `fixtureHttp`. Bare `*`, `*.com` and mid-label wildcards are still rejected.
  - `ScopedHttp.getText()` for HTML/XML; `SourceTarget.options` (per-target overrides from `company_sources.config`); optional `RawPosting.companyName` (for non-company sources, used in Phase 7).
  - `source-helpers.ts`: `parseRelativePosted` ("Posted 3 Days Ago"), `matchesLocationFilter`, `remotePolicyFromText`.
  - `ats-tokens.ts`: board-token formats for Workday (`tenant.wdN/Site`, `wdN.myworkdaysite.com/tenant/Site`), SuccessFactors (`career4.successfactors.com/<companyId>` or an SAP-hosted RMK host) and Taleo (`tenant/section`), shared by the plugins and the core detector.
  - `fixtureHttp` serves `"POST <url>"` routes, text/HTML bodies, extra headers, and request-dependent routes (e.g. a page offset in a POST body).
- `packages/db` — migration `0006`: `ats_type` gains `workday`, `smartrecruiters`, `successfactors`, `taleo`; `company_sources.config jsonb` + `detected_by`; `companies.discovered_via`, `discovered_at`, `ats_checked_at`. New `discovery-repo.ts`: `saveDiscoveredCompany` (company + boards in one transaction, deduped by domain then name, fills blanks only), `findCompanyByDomain`, `listCompaniesForAtsCheck`, `markSourceStale`, `listRecentlyDiscovered`, `discoveredCountSince`.
- `plugins/source-workday` — CXS API: paged `POST …/wday/cxs/{tenant}/{site}/jobs` (20/page; `total` read from the first page only) + per-posting detail `GET`. Location filter runs on the list's `locationsText` before any detail request ("N Locations" postings are resolved from the detail). Options `searchText`, `locations`, `maxPostings`, `fetchDetails`, overridable per target. 1 req/s per tenant host. A failing detail keeps the list-level posting; a malformed token is a permanent failure.
- `plugins/source-smartrecruiters` — `GET /v1/companies/{id}/postings` (100/page) + detail for the job ad (sections assembled job → qualifications → additional → company). 2 req/s. Same location filter/options.
- `packages/core/discovery`
  - `detect.ts`: pure `classifyUrl` for all seven ATSs, `scanHtml` (links, embeds, inline Greenhouse/Lever configs, SuccessFactors RMK signature on custom domains), `careerLinks`, `registrableDomain`, `normalizeDomain`, `slugCandidates`.
  - `robots.ts`: RFC 9309 subset (UA groups, longest match, `*`/`$`), per-origin cache; 4xx = allow, 5xx = disallow, network failure = unreachable.
  - `page-fetcher.ts`: the only path for visiting arbitrary company sites — https-only (http upgraded), robots checked on every redirect hop, 1 req/2 s per host, body cap.
  - `discover-ats.ts`: `{domain}/careers`, `/jobs`, `/join-us`, plus `careers.`/`jobs.` subdomains → a redirect onto an ATS host is conclusive (confidence 1) → page scan → one hop of same-site job links → name probes against the Greenhouse/Lever/Ashby/SmartRecruiters public APIs (lower confidence). `discoverAndSave` persists detections ≥ `discovery.minConfidence`.
  - `lists.ts` + `run.ts`: `discover_companies` list adapters — `yc` (yc-oss `all.json`, hiring + region filter, no LLM), `gcc-journal`, `wellfound`, `internshala`, `hirect` (LLM `extract` over page text, chunked). Batch dedupe, skip known companies, detect, save; `plugin_runs` (`discovery:<list>`) + `discovery.run` events.
- `apps/cli` — `jf discover_ats <domain|name> [--name] [--save] [--no-probe]`, `jf discover_ats --missing [--limit]`, `jf discover_companies --list <id> [--max-new] [--dry-run] [--concurrency]`. CSV import understands `workday_tenant` / `workday_site` / `smartrecruiters_company_id` columns (URLs accepted and normalised).
- `apps/server` — `POST /api/companies/discover-ats`, `POST /api/discovery/run` (background, one at a time), `GET /api/companies/discovered`.
- `apps/mcp` — `discover_ats`, `discover_companies`, `recent_companies` tools (none destructive).
- `config.yaml` — new `discovery` section (`minConfidence`, per-list `urls`/`regions`/`maxNew`/`enabled`, `alertThreshold`, `recheckDays`, `nightly`).
- `data/companies.seed.csv` — 280 companies (was 49): 50 Workday tenants, 1 shared-host Workday board and 4 SmartRecruiters boards marked `unverified seed`, plus ~175 GCCs (BFSI, retail, FMCG, pharma, medtech, industrial, semis, SaaS, consulting, Indian majors) seeded with a domain for `jf discover_ats --missing`.

Dependencies: none added.

Known gaps: fixtures for Workday/SmartRecruiters are synthetic (no network access to those hosts while building); the Workday/SR seed boards are from memory and unverified; the "50+ companies from gcc-journal in one run" acceptance needs a live run.

## [Phase 7] — Alert-email + SuccessFactors + Taleo sources

- `packages/plugin-sdk`
  - `GmailHandle.getMessageBody()` (read scope) returns the decoded HTML/text parts; `fakeGmail` supports it plus `from:` search terms and HTML bodies.
  - `ctx.emit(kind, data)`: plugins can append audit events; the core stores them as `plugin.<id>.<kind>`.
  - `markup.ts`: `xmlElements` / `xmlChild` (CDATA-aware) and `sanitizeHtml` — the strict cleanup for ATS-authored HTML (drops inline styles, fonts, spans, MS Office markup, every attribute but `href`).
- `plugins/source-gmail-alerts` — reads the user's job-alert emails (no network permissions; Gmail read only). An HTML-email tokenizer + job-card extractor groups the logo/title/button links of each job by the portal's job id, then reads company/location from the text after (or, for YC, before) the title, skipping experience/salary/"Actively recruiting" noise. One parser file per sender: LinkedIn Job Alerts, Naukri, Wellfound weekly, YC Work at a Startup, Instahyre, Internshala, Unstop. Non-alert mail from the same sender is ignored via a marker; an alert with no recognisable jobs emits `parse_empty`; an exception emits `parse_failed`; neither stops other senders.
- `packages/core`
  - `runAlertSource`: employers in alerts are matched to known companies with a looser key (`companyMatchKey`: "Walmart Global Tech India" → "Walmart Global Tech", "Target Corporation India" → "Target"), otherwise created (`discovered_via = gmail-alert`); postings merge into canonical jobs through the existing fingerprint; alerts never close jobs; a cursor in `app_state` (with a day of overlap) keeps reruns cheap; plugin events are persisted.
  - Gmail client: `getMessageBody` via `format: full` with nested multipart walking (`extractBodies`).
  - `SOURCE_PLUGIN_FOR_ATS` adds successfactors and taleo.
- `plugins/source-successfactors` — two board kinds (token formats from Phase 6): classic `career4.successfactors.com/<companyId>` via the XML job-listing feed (element-name aliases tolerated), and SAP-hosted RMK sites (`jobs.<tenant>.sapsf.com`) via the HTML search pages (`tr.data-row`, 25/page, "of N" total) + job pages. All descriptions go through `sanitizeHtml`. 1 req/s per host.
- `plugins/source-taleo` — best effort: discovers the portal id from `careersection/<section>/jobsearch.ftl` (or takes `company_sources.config.portal`), then pages `rest/jobboard/searchjobs` (25/page) and maps `[title, locations, date]` columns. No descriptions (rendered client-side). 1 req/s per host.
- `discover_ats` already recognised SuccessFactors (`career*.successfactors.*`, `*.sapsf.*`, RMK signature on custom domains) and Taleo (`*.taleo.net/careersection/<section>`) since Phase 6.
- `apps/cli` — `jf fetch` also reads job alerts when Gmail is connected (`--no-alerts` to skip; `--plugin source-gmail-alerts` for alerts only); `jf gmail alerts [--since] [--dump <messageId>]`; `jf gmail subscribe-template` prints the portal alert searches to set up from `preferences.yaml`.
- `apps/server` — polls job alerts every 30 minutes when Gmail is connected (read-only, so in dev mode too).
- `apps/mcp` — `run_source` accepts the new source plugins.

Dependencies: none added. (`@jobforge/source-gmail-alerts` is a dev dependency of `@jobforge/core` for its runner test.)

Known gaps: all fixtures are synthetic; the "5 SuccessFactors + 3 Taleo tenants return postings" and "real inbox" acceptance runs need live access and real tenant ids.

## [Phase 8] — Per-job referral fan-out (10+ contacts per job)

- **Policy change (user-approved in PLAN-phases-6-13):** no global daily send cap and no per-company weekly cap by default. `outreach.dailyCap` / `perCompanyPerWeek` are now `null` (opt-in). Always enforced: `perContactCooldownDays` (30 — a person is never asked twice across any job or channel, counting pending/approved asks too), `perJobReferralCap` (10, overridable per batch), and the sender's technical limit `senderDailyLimit` (400, Gmail). `CLAUDE.md` updated.
- `packages/db` — migrations `0007` + `0008`: `contacts.role_hint`, `seniority_hint`, `department`, `email_candidates`; `companies.linkedin_id`, `linkedin_slug`; review kinds `referral_ask` and `attention`; `job_referral_batches` (one per job: requested/drafted/sent/replied counts, status `drafting → pending_review → sending → sent → replied | closed`); `review_items.batch_id`; `outreach_threads.channel` (`email | linkedin`). `referral-repo.ts`: batches, `lastAskedAt`, `contactsAskedSince`, `committedAsksForJob`, `markBatchReplied` (stops only that batch's follow-ups), hints/LinkedIn identity setters.
- `packages/plugin-sdk`
  - `OutreachActionInput.kind` gains `referral_ask` with `resumeBullets`; `ContactRef` gains role/department/LinkedIn hints; `EmailDraft.resumeBulletId`; `linkedinNoteDraftSchema` (≤ 300 chars) and `LinkedInSendResult`; `EmployeeEnrichment`; `CompanyEnrichment` candidates.
  - Browser capability: `BrowserPage` (a Playwright-compatible subset) + `BrowserHandle`, `SessionBlockedError`; `fakeBrowser` (scripted pages, click handlers, action log) for tests.
  - `linkedin.ts`: `assertNotBlocked` (checkpoint/captcha/authwall/restricted/limit/999), `classifyHeadline` (role/seniority/team), `parsePeopleSearch`, `parseCompanyId`/`Slug`, `peopleSearchUrl`, `canonicalProfileUrl`.
- `packages/core`
  - Outreach engine: per-contact cooldown and per-job cap checked at approval *and* right before sending (an approved item that became invalid fails with the reason); the optional caps only apply when configured; referral asks open threads; sends bump batch counts; a reply on any batch thread marks the batch `replied`, cancels that batch's follow-ups, and emits `referral.replied` for the Phase 12 sequencer. Drafts are validated per actor (email vs LinkedIn note).
  - `referrals.ts`: `fanOutReferrals(jobId, {count})` (one batch per job, ranks reachable engineers → managers → leaders → recruiters, email when confidence ≥ `referralMinEmailConfidence` else LinkedIn, skips cooldowns, optionally finds more people first; resumable — reruns top up without duplicates), `approveBatch` ("one click"), `referralPanel`, resume bullets extracted from the job's tailored `.tex` (fallback: profile facts).
  - `browser.ts`: Playwright launch (lazy import) + `scopeBrowser` (manifest domains on every goto and after clicks, per-domain rate limit). `session-store.ts`: AES-256-GCM session file (mode 600), key from `JOBFORGE_SESSION_KEY`, the OS keychain (`security`/`secret-tool`), or a 600 key file.
  - `linkedin.ts`: gate (`LINKEDIN_ENABLED` + live), health state with doubling cool-down, `pauseLinkedIn` → `attention` review item, `resumeLinkedIn`, `importLinkedInEmployees` (contacts with `source = linkedin` + hints, then email inference), shared browser factory.
- `plugins/enricher-contacts-pattern` — ranked candidate addresses per contact (`candidatesPerContact`, default 3) and `patternCandidates` per company; persisted to `contacts.email_candidates`.
- `plugins/enricher-linkedin-employees` — company search → company id → people search per keyword (`currentCompany` filter), human-ish pauses/mouse/scroll, `searchIntervalSeconds` (60) between searches, 1 navigation / 15 s; dry run never opens LinkedIn; stops on any challenge page.
- `plugins/actor-gmail-outreach` — `referral_ask` prompt: ≤ 90 words, names the role, cites exactly one resume bullet (validated id; repair retry otherwise), always carries the posting URL.
- `apps/cli` — `jf referrals fanout|show|approve <jobId>`, `jf linkedin login|status|resume|employees`; review list/show render LinkedIn notes and attention items.
- `apps/server` — `GET /api/jobs/:id/referrals`, `POST …/referrals/fanout`, `POST …/referrals/approve`, `GET /api/linkedin/status`, `POST /api/linkedin/resume`; review list accepts the new kinds; `attention` approval = "fixed, resume".
- `apps/web` — per-job **Referrals** panel (batch counters, each ask with channel/status/reply, per-row approve, "Approve all N" with confirmation, top-up); review queue dispatches LinkedIn-note and attention cards.
- `apps/mcp` — `fan_out_referrals`, `referral_status`; `approve` confirmation text covers LinkedIn notes, attention items and applications.

Dependencies added: `playwright` (in `packages/core`; listed in PLAN.md §2).

Known gaps: the LinkedIn markup and the alert/ATS fixtures are synthetic; autopilot's `fanOutReferrals` hook is wired in Phase 12 together with the sequencer.

## [Phase 9] — LinkedIn referral actor + tracker (dedicated account)

- `plugins/actor-linkedin-referral` (`sideEffects: external`, `www.linkedin.com` only, LLM + browser)
  - `prepare()`: LLM connection note ≤ 300 characters citing exactly one resume bullet (validated; repair retry), grounded in the Phase 8 referral prompt.
  - `execute()`: profile → pre screenshot → already *Pending* / *1st* = no-op (never twice) → human-ish mouse jitter → Connect (or More → Connect) → Add a note → type the note character by character → Send → post screenshot. Any checkpoint/captcha/login/restricted/weekly-limit page throws `SessionBlockedError`. All selectors in one `SEL` table.
- `plugins/tracker-linkedin` (read-only): accepted connections (connections page, "Connected N ago") and inbox threads whose last message is theirs.
- `packages/core`
  - `runLinkedInSendTick`: dry-run previews without a browser unless `LINKEDIN_ENABLED` + live; live = one request per tick under a lease, `linkedin.dailyConnectionCap` (25), random `actionGapSeconds` (45–120 s), referral limits re-checked; a block pauses all LinkedIn loops, raises an `attention` review item, and leaves the item approved for after the resume; other errors retry up to 3 times. Sent asks open a `channel = linkedin` thread with no follow-ups and bump the batch.
  - `pollLinkedInTracker`: matches events to LinkedIn threads by profile URL (or name); an accepted connection or reply marks the thread replied → batch `replied` → `referral.replied` (Phase 12 signal). Cursor in `app_state`.
  - `coreApprovedDraft()` mints ApprovedDrafts for any actor (core-only); the browser capability is optional at context build (`prepare()` never browses); the LinkedIn browser factory saves refreshed cookies back to the encrypted store.
- `apps/cli` — `jf linkedin send [--live] [--watch]`, `jf linkedin track [--live]`.
- `apps/server` — `linkedin.send` (every minute) and `linkedin.track` (every 30 min) pg-boss loops when `LINKEDIN_ENABLED=true` and `MODE=live`.
- `docs/linkedin.md` — account setup, login, flow, safeguards.

Dependencies: none new (Playwright arrived in Phase 8).

Known gaps: the "one real connection request" and "accepted connection flips the ask" acceptance runs need your dedicated account; they are exercised here with a scripted fake browser, including an injected security-check page.

## [Phase 10] — Deadline inference (LLM + web search)

- `packages/shared` / `packages/llm`
  - New LLM task `research` (routable in `config.yaml`). `LLMRequest.webSearch` asks the provider for a search tool; `LLMResponse.webSearch = { used, citations }` reports whether it actually had one.
  - Claude Code adapter: `webSearch` pre-approves only `WebSearch` and `WebFetch` via `--allowedTools` (everything else stays denied by `--permission-mode dontAsk`).
  - OpenRouter adapter: adds the `web` plugin (`max_results: 5`) and returns `url_citation` annotations; when the plugin is rejected (400/402/404) it answers without search, reports `used: false`, and remembers that for the process.
  - `createFakeProvider` can simulate search results.
- `packages/db` — migration `0009`: `jobs.inferred_deadline date`, `deadline_confidence real`, `deadline_rationale text`, `deadline_sources jsonb`, `deadline_inferred_at timestamptz`, plus `jobs.closed_reason` (`gone | deadline | manual`). A job closed because its deadline passed (or by hand) is **not** reopened when a board lists it again; `closeStaleJobs` now records `gone`. `deadline-repo.ts`: `saveDeadline`, `jobsNeedingDeadline` (LLM-scored ≥ `minMatchScore`, never estimated or older than `staleDays`), `closeExpiredDeadlines`. Job detail and the ranked list carry the deadline.
- `plugins/enricher-deadline` — prompt per the plan ("Given this company + role + 2027 batch, what is the typical application close date? Use web search. Cite sources."), zod-validated `{deadline: YYYY-MM-DD | null, confidence, rationale, sources[]}` (repair retry on malformed dates); provider citations merged into sources; confidence capped at 0.35 without search and 0.5 when nothing was cited; a null deadline has confidence 0.
- `packages/core/deadline-runner.ts` — `runDeadlines` (per-job failures don't stop the batch; `job.deadline_inferred` events), `expireDeadlines` (closes jobs whose deadline passed ≥ `expireGraceDays` ago with confidence ≥ `expireMinConfidence`; `job.expired` events), `isDeadlineImminent(job, now, days)` — the Phase 12 "deadline near" predicate (ignores estimates under 40 % confidence).
- `config.yaml` — `deadlines: { minMatchScore: 60, staleDays: 14, batchSize: 20, expireMinConfidence: 0.6, expireGraceDays: 1, nightly: false }`.
- `apps/cli` — `jf deadlines [--job <id>] [--limit] [--rescore]`; `jf jobs list` shows a DEADLINE column (`?` for low confidence); `jf llm check` lists the research route.
- `apps/server` — `POST /api/jobs/:id/deadline`; optional nightly `deadlines.nightly` loop.
- `apps/web` — job detail **Application deadline** card (date, days left with colour, confidence, expandable rationale with linked sources, Estimate/Re-estimate); the job list shows confident deadlines.
- `apps/mcp` — `infer_deadline(jobId)`.

Dependencies: none.

Known gaps: the "20 real GCC postings with cited deadlines" acceptance needs real LLM calls with search (costs money; not run here).

## [Phase 11] — ATS auto-apply via Playwright (Greenhouse → Lever → Ashby)

- `profile/preferences.yaml` gains an **`application`** section (name, email, phone, location, LinkedIn/GitHub/website, current company/title, university, degree, per-country `work_authorization`, `requires_sponsorship`, `notice_period_days`, recurring `answers` by label substring, optional `eeo` answers where `decline` picks the form's decline option). It is excluded from the profile-version hash, so editing it doesn't force a re-match.
- `packages/plugin-sdk/apply.ts` — `ApplyInput`, `FormQuestion`, `applicationDraftSchema` (fields with value + source, `missingRequired`, preview screenshots, `profileVersion`), `ApplicationResult`; **`mapAnswers`** is deterministic and never invents (free-text "why us?" questions stay blank for the human; select answers must match an existing option); `fillForm` and `runApplyFlow` (fill → full-page screenshot → only when live: submit → wait for confirmation → screenshot; a captcha throws `SessionBlockedError`). `ActorPlugin.preview?()` (no side effects) added to the contract.
- `plugins/actor-apply-greenhouse` — questions from the public job API (`?questions=true`, incl. location and EEOC compliance questions), the classic embedded form (`boards.greenhouse.io/embed/job_app`) with id-addressed fields, `#submit_app`, confirmation detection.
- `plugins/actor-apply-lever` — questions parsed from the hosted apply page (`li.application-question`, ✱ required, `cards[...]` radios, `eeo[...]` selects), `#btn-submit`.
- `plugins/actor-apply-ashby` — form definition via the public non-user GraphQL `ApiJobPosting` query (sections/fieldEntries, Boolean/ValueSelect as radios, EEO section), attribute selectors (UUID paths can start with a digit).
- All three: dry run fills and screenshots but **never clicks submit**; execute refuses while required answers are missing; screenshots go to `data/screenshots/apply/` (absolute repo path regardless of cwd).
- `packages/core/apply.ts` — `draftApplication(jobId)` (resolves the Greenhouse/Lever/Ashby posting behind the canonical job, requires a rendered tailored resume and the `application` section, refuses duplicates, optional preview screenshots stored on the draft); `runApplyTick` (lease, one real submission per tick, idempotency key **`apply:{job_id}:{profile_version}`** — a retried or duplicated application replays the stored result and is marked executed without resubmitting; captcha → `failed` "needs a manual application"; other errors retry once). Editing an application draft (`{fields: [{key, value}]}`) recomputes `missingRequired`; approval is refused until it's empty. `actions.result.screenshots[]` is the audit trail; `application.submitted` events.
- `packages/db` — `applyTargetForJob`, `reassignAction`.
- `apps/cli` — `jf apply draft <jobId> [--no-preview]`, `jf apply send [--live] [--watch]`.
- `apps/server` — `POST /api/jobs/:id/apply`, `GET /api/review/:id/screenshots/:n` (PNG only, confined to `data/screenshots`), `apply.send` loop every 5 minutes in `MODE=live`.
- `apps/web` — job page **Apply** panel; review-queue **Application** card (every answer visible/editable with its source, required gaps highlighted, filled-form preview screenshots, approve disabled until complete).
- `apps/mcp` — `draft_application(jobId)` (approval still goes through `approve` with confirmation).

Deferred per plan: Workday / SuccessFactors / Taleo auto-apply (manual apply with referral + resume prep).

Dependencies: none new.

Known gaps: real submissions (one per ATS) need your live run; the newer React-based Greenhouse forms (job-boards.greenhouse.io) and Ashby's custom select controls may need selector work — the classic Greenhouse embed form is used for that reason.

## [Phase 12] — Autopilot sequencing: referral-first, apply-on-deadline

- `packages/db` — migration `0010`: `job_pipeline_state` (`job_id` PK, `state` enum `candidate | referral_pending | ready_to_apply | applied | expired | failed`, `entered_state_at`, `metadata jsonb`). `pipeline-repo.ts`: `enterPipeline` (idempotent), `transitionPipeline` (row-locked, only from the expected states, writes a `pipeline.transition` event), `updatePipelineMetadata`, `jobsInState`, `pipelineStateCounts`, `listApplications`, `jobTimeline` (transitions + job events + every review item's events, in order).
- `packages/core/sequencer.ts` — `runSequencer` (one tick, under a lease):
  1. expire non-terminal jobs whose posting closed (`deadline_passed` / `posting_closed`) unless an approved application is about to go out;
  2. `ready_to_apply` → `applied` / `failed` / `expired` from the application review item (submitted / failed / rejected by you);
  3. `referral_pending` → `ready_to_apply` on a reply (`referral_replied`), an imminent inferred deadline (`deadline_imminent`, Phase 10 predicate), or `referralWaitDays` after the first ask actually went out (`wait_elapsed`);
  4. queue the application (Phase 11) — or flag `manualApply` when the posting isn't Greenhouse/Lever/Ashby;
  5. admit top-ranked jobs that pass the match + tailor gates, up to `maxConcurrentJobs` in flight;
  6. `candidate` → `referral_pending`: fan out (Phase 8) and auto-approve asks whose draft confidence clears `confidenceFloor.outreach` (budget `maxAutoApprovedAsksPerDay`); no reachable contacts → straight to `ready_to_apply` (`no_referral_contacts`).
  Resumable: every step is state-guarded and the side steps are idempotent (one batch per job that tops up; one application per job + profile), so a run killed mid fan-out finishes on the next tick without duplicate asks.
  `advanceJob` (manual push one step; `ready_to_apply` → `applied` = applied by hand) and `expireJob(reason)`.
- `config.yaml` — `autopilot.strategy: referrals | single_email` (default `referrals`), `referralWaitDays` (2), `deadlineImminentDays` (3), `maxConcurrentJobs` (50), `referralsPerJob` (null = `outreach.perJobReferralCap`), `autoApproveReferrals` (true), `maxAutoApprovedAsksPerDay` (200), `autoApproveApplications` (false). No global send cap.
- `apps/cli` — `jf autopilot` runs one sequencer tick under `strategy: referrals` (the old loop under `single_email`); `jf pipeline list [--state] [--company] | show <jobId> | advance <jobId> | expire <jobId> --reason`.
- `apps/server` — `GET /api/applications`, `GET /api/applications/:jobId/timeline`, `POST /api/jobs/:id/advance`, `POST /api/jobs/:id/expire`, `POST /api/autopilot/sequence`; `/api/autopilot/run` and the hourly cron follow the strategy; `/api/pipeline` includes per-state counts.
- `apps/web` — **Applications** tab: state filter chips with counts, company filter, each job's state, why, asks sent/replied, deadline, application status, manual Advance / Mark applied / Expire, expandable timeline, "Run sequencer now".
- `apps/mcp` — `pipeline_status` now includes per-state counts; new `advance_job(jobId)` and `expire_job(jobId, reason)`.

Dependencies: none.

Known gaps: "20+ real jobs across all states" needs live data; the full flow is exercised end to end in `sequencer.db.test.ts` (admit → fan-out → send → reply / deadline / wait → apply → applied / expired, plus the kill-and-resume case).

## [Phase 13] — Continuous company discovery

- `packages/core/discovery/continuous.ts`
  - `runNightlyDiscovery`: crawls every enabled company list (`discovery.lists.<id>.enabled`, default on), skipping LLM-assisted lists (Wellfound / Internshala / Hirect) when no LLM is configured, runs `discover_ats` on each new candidate, then queues `source.fetch` for every board added during the run. Writes a `discovery.nightly` event with per-list counts.
  - `runAtsRecheck` (plugin run id `enricher-company-ats-recheck`): re-detects the ATS of companies whose `ats_checked_at` is older than `discovery.recheckDays` (30), adds newly found boards (`detected_by = 'recheck'`) and queues them, and marks an old board **stale** (status `paused`, never deleted, reason recorded) only when the careers site now points at a different board *and* the old one is failing or returned 0 postings on its last successful fetch. Name-slug probe hits are ignored for companies that already have an active board.
- `packages/db` — `setCompanyTags`, `addCompanySource`, `newSourceIdsSince`, `lastSuccessfulPostings`, `markAtsChecked(at)`; `listSourceTargets` and the re-check skip companies tagged `excluded`.
- `config.yaml` — `discovery.nightly` (default `false`), `discovery.recheckDays` (30), `discovery.alertThreshold` (40).
- `apps/server` — pg-boss crons `discovery.nightly` (03:41) and `discovery.recheck` (04:13) when `discovery.nightly: true`; `POST /api/discovery/nightly`, `POST /api/discovery/recheck`, `POST /api/companies/:id/tags`; `GET /api/companies/discovered?days=` returns `lastDay` / `alert`.
- `apps/web` — **Companies** tab: companies discovered in the last 1 / 7 / 30 days with their boards (stale ones struck through), Exclude / Include, add / remove tags, "Run discovery now", "Re-check ATSs". A dashboard-wide amber banner appears when discovery added more than `alertThreshold` companies in 24h.
- `apps/cli` — `jf discover_companies --all` (the nightly run, once), `jf discover_ats --recheck [--limit N]`.
- `apps/mcp` — `tag_company(companyId, add?, remove?)`.

Dependencies: none.

Known gaps: "10–30 new companies/week, each with a working source" needs the live crawl (egress is blocked here). The Greenhouse → Workday move and the no-duplicates property are covered in `continuous.db.test.ts`.

## [Phase 14, partial] — Review-queue backpressure

- `config.yaml` — `autopilot.maxPendingReviews` (default 300, `null` = never pause).
- `packages/core/sequencer.ts` — when at least that many review items are pending, the tick still expires, syncs, advances and queues applications for jobs already in flight, but admits no new jobs and fans out no new asks. The summary / `autopilot.sequence` event carry `paused: "review_queue_full (N pending ≥ max)"`; the Applications page shows it after "Run sequencer now".

The other Phase 14 items (plugin process isolation, funnel analytics, daily digest email) are not started.

## [Fixes after Phases 6–14] — issues from the agent log, verified against live sites

- **Shared plugin list**: `@jobforge/plugins` (`createRegistry`) replaces the two copies in the CLI and server (the server's lacked `matcher-default`); a test fails if a `plugins/*` package isn't registered.
- **Contacts**: identity is the LinkedIn profile when there is one, the name otherwise (migration `0011`: partial unique indexes, stored profile URLs normalised). Two same-name people are two contacts; a bare name matching several profiles is refused (CLI error, HTTP 409). The LinkedIn tracker no longer guesses between same-name contacts.
- **Bounces**: a bounced pattern-guessed address moves to the next ranked candidate; known addresses and exhausted candidates still mark the contact bounced. `contacts.bounced_emails` (migration `0012`) stops re-enrichment from re-picking a bounced address. A bounced ask doesn't count toward the cooldown or the job's referral cap, so the fan-out can re-ask at the new address.
- **Bug**: `contactsAskedSince` had an unparenthesised `or` in raw SQL that escaped the other filters.
- **source-workday**: stub list entries (`bulletFields` only) are skipped instead of failing the board; a 422 says the tenant/site may have moved. Fixtures recorded from State Street and Abbott.
- **Seeds**: all 52 Workday/SmartRecruiters boards checked live. Walmart (`wd504`), Lilly (`wd115`) and Expedia (`wd108`) moved data centre; Qualcomm and Dell left Workday (domain only now); Franklin Templeton and Visa are correct but returned 0 postings. 50/52 return postings.
- **Apply forms**: the Greenhouse, Lever and Ashby question parsers were run against live public forms (Stripe, Spotify, Linear) and read every question correctly (no submission made).
- **Misc**: `.gitignore` restored for `my_resume.tex`; `--allowedTools` is passed as one comma-joined value; `docker-compose.yml` pins `max_connections=100` (initdb had chosen 20, which the parallel DB tests exhaust).

Dependencies: none added (`@jobforge/plugins` is a workspace package).

## [Phase 15] — Resume engine: one-page fit + skills rewrite v2

- `plugins/tailor-resume-latex/src/fit.ts` — deterministic one-page fit loop after assembly: compile; while over one page, rescale every LaTeX size command for the whole document (10pt → 9.5 → 9pt, floor `fit.minFontPt`), then `\linespread` (1.0 → 0.97 → 0.94, floor `fit.minLinespread`), then LLM bullet shortening; still over → `overflow`. Typography goes into a `%%FIT%%` slot if the preamble has one, else just before `\begin{document}`; `preamble.tex` is never edited. `fix-cm` is loaded when the font is scaled so `\Huge`/`\LARGE` scale exactly.
- `plugins/tailor-resume-latex/src/shorten.ts` — length-only shortening of the `fit.shortenBullets` (4) longest bullets, up to `fit.maxShortenRounds` (2) rounds. Guardrail (`validateShortening`, `RewriteValidation` shape) reverts any rewrite that adds a number, a proper noun / tech term, or a LaTeX command, isn't shorter, is empty, or has unbalanced braces/`$` or an unescaped `%`. A round whose `.tex` fails to compile is reverted as a whole.
- `skills.ts` v2 — the prompt gets the JD + the full assembled resume; allowed items = the skills fragment's items ∪ the selected blocks' tech-stack items (`tech_stack_line`, else `\emph{...}`). Anything else is still rejected.
- Plugin config `fit: { enabled, minFontPt, fontStepPt, minLinespread, linespreadStep, maxShortenRounds, shortenBullets }` (documented in `config.example.yaml`).
- `packages/plugin-sdk` — `TailorStatus` gains `overflow`; `TailoredResume.fit` (`FitInfo`: fontPt, linespread, shortenedBullets, rounds, compiles, pages).
- `packages/db` — migration `0013`: `resume_status` enum gains `overflow`; `resume_variants.fit jsonb`.
- `packages/core` — the tailor runner stores `fit`, records `overflow` variants (PDF kept) and raises an `attention` review item; autopilot skips them (`tailor_overflow`); the sequencer already only uses `rendered` variants.
- Dashboard — `overflow` status badge; the variant card shows the fit (`fit 9pt × 0.94 · 2 shortened`).
- Tests: fake-compiler fit tests on the real resume blocks (typography-only fit, shortening with an invented-number revert, overflow, compile-failure revert), a real `latexmk` test that takes a 2-page document to 1 page (skipped without LaTeX), guardrail tests, skills v2 tests (tech-stack-only `Groq` accepted, invented `Kubernetes` rejected), runner overflow test.
- Roadmap: the planned "sub-phase 3" LLM bullet rewrites (Phase 5.5 deferred list) are dropped; length-only shortening above replaces them.

## [Phase 16] — ATS score checker + resume library and selector

Design revised with the user before implementation (recorded in `PLAN-phases-15-23.md` §16): resumes are generated up front as project combos; per-job tailoring is only the Technical Skills rewrite.

- `packages/core/src/ats-score/` (deterministic, no LLM):
  - `extractPdfText` — pdf-parse (moved here from the server) with a position-aware page renderer: items on one line separated by a gap get a space (the default renderer glued `\hfill`'d dates to titles), and words hyphenated across a line break are re-joined.
  - Parse checks: extractable text, encoding (control chars / U+FFFD / ligature codepoints / `(cid:N)`), run-together words, standard section headers, contact (email + phone), parseable date ranges, reading order, column run-ins.
  - JD keywords: tech lexicon (~140 terms with aliases; ambiguous ones like Go/C/R/Express matched strictly) ∪ the user's stack + skill facts, tiered hard / normal / soft by JD section and inline "required" / "a plus", plus TF-IDF phrases over a sample of the job corpus. Weighted coverage, missing keywords, missing hard requirements.
  - Per-ATS profiles (greenhouse, lever, ashby, workday, smartrecruiters, successfactors, taleo, generic): keyword-search ATSs weight coverage; parse-and-fill ATSs weight sections, dates and columns. `scoreResume` / `scoreAllAts`.
  - Fixtures: real pdflatex PDFs — clean (CM Type 1) and broken ligatures (T1 bitmap fonts).
- Resume library (`packages/core/src/resume-library.ts`):
  - `generateLibrary` renders every subset of exactly `resumes.projectsPerResume` (3) projects plus `profile/resume/base/*.yaml` (ships `default.yaml` = all blocks). Combos get their skills tailored to their own projects (one LLM call each); base resumes keep the original skills; all go through the Phase 15 fit loop. Existing ones are skipped; `retire` = scrap & regenerate, retiring the old set only once something new rendered (rows and PDFs kept).
  - Benchmarks: categories (default SWE intern, AI/ML engineer; editable), 5 JDs each auto-picked from open jobs by title keywords + match score (pinned JDs are never replaced); every library resume × JD scored under every ATS profile.
  - `selectResumeForJob`: earlier decision → resume already made for the job from the current profile → else score every non-retired library resume against the real JD (`0.4·similarity` rescaled 0.5→0 / 0.9→100 `+ 0.6·ATS` for the job's ATS; benchmark averages break near-ties), then rewrite only the chosen combo's skills for the job and keep it when its ATS score is ≥ the combo's. `selector.threshold` (75) only flags a weak fit. Empty library → Phase 15 per-job generation. `force` re-picks and reruns the skills rewrite.
- Tailor plugin: `listCombos`, `renderFixed` (SDK `TailorPlugin` gains both as optional methods); the skills rewrite can target a job or "no job" (the combo's projects).
- DB migration `0014`: `resume_variants` gains `kind` (generated|combo|base|tailored), `combo_key`, `label`, `parent_variant_id`, `retired_at`, `ats_score`, `resume_text`, `embedding`; `job_id` is nullable. New `job_resume`, `resume_benchmark_categories`, `resume_benchmark_jobs`, `resume_benchmark_scores`. `latestRenderedResumeForJob` resolves through `job_resume`, so apply and outreach attachments use the selector's choice.
- Sequencer and autopilot use the selector instead of `runTailor`.
- Server: `routes-library.ts` — `POST /api/jobs/:id/tailor {force}`, `GET /api/jobs/:id/resume-variants` (+ decision), `/api/resumes/library` (+ `/run`, `/generate {retire}` as a background run that benchmarks when done), categories, pinned JDs, auto-pick, re-scoring.
- CLI: `jf tailor <jobId> [--force]`, `jf resumes generate [--retire] | list [--all] | bench [--pick]`.
- Dashboard: new **Resumes** tab (library with per-category benchmark averages, per-ATS breakdown per JD, Generate missing / Re-run benchmarks / Scrap & regenerate, benchmark categories and JDs with search-to-pin); the job page shows the selector decision, ATS score card (missing hard requirements, keyword hits/misses, parse checks), library ranking, and Pick resume / Generate new.
- Config: `resumes.{projectsPerResume, selector, benchmarks}` (documented in `config.example.yaml`). Tailor deps carry a lazy local embedder (model loads on first use).
- Dependencies: `pdf-parse` moved from `apps/server` to `packages/core` (noted in the plan). No new packages.
