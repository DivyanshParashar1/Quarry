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
