# Quarry: Phase 24 — Compose (personal referral mail writer) + sent-mail log

> Extends `PLAN.md` and `PLAN-phases-15-23.md`. Same working rules as `CLAUDE.md`: tests alongside code,
> fixtures only in CI, stop at phase end for review, no `Co-Authored-By` trailer.

---

## Decisions taken with the user (2026-10-29)

| Topic | Decision |
|---|---|
| Shape | One new dashboard page, **Compose**: a Gmail-style editor (To / Subject / Body / attachments / Send) with a **Generate** side panel. Separate from fan-out; nothing here runs unattended. |
| Personalization source | **Only what the user provides.** No auto-pulling receiver info from Contacts, Jobs, LinkedIn or the web. |
| Variants | Every generation returns **two variants side by side**; the user picks one, which loads into the editor. |
| Sending | Pressing **Send** (or **Schedule**) is the approval: the server creates a `review_items` row (kind `compose`), approved by the human, and sends through `actor-gmail-outreach` right away (no spacing; the sender's daily limit and the per-contact cooldown still apply). `dryRun` rules unchanged. |
| Sent-mail log | **Every** email Quarry sends is logged in `sent_emails`: compose, outreach, referral asks, follow-ups — recipient, subject, body, attachments (with a kept copy), Gmail ids, and for compose the full input (form, notes, both variants, which was picked, the final edits). Existing sends are backfilled. Dashboard **Sent** view. |
| Batch | One compose session can hold several recipients; shared purpose/projects/notes, per-recipient receiver info; two variants per recipient. Each recipient is its own review item + log row. |
| Scheduling | **Runs on Google's side.** The Gmail API has no scheduled send, so a scheduled mail becomes a Gmail draft carrying an `X-Quarry-Send-At` header, and a Google Apps Script the user installs once (time trigger, every 5 min) sends due drafts. Works with Quarry off. Quarry reconciles later (draft gone + a SENT message in its thread → sent; no SENT message → cancelled). Needs the `gmail.compose` scope (one re-auth). |

## Scope

### Generate panel (form)
- **What the mail is about** (free text) + a purpose preset (referral ask, cold intro, follow-up, thank-you, coffee chat).
- **About the receiver** (free text, per recipient), receiver name, optional company (lets Quarry match/create the contact so cooldown and reply tracking work).
- **Projects to mention**: checkboxes over the `project` facts in the active profile + free-text detail.
- **Tone** (formal / neutral / casual), **length** (short / medium / full).
- **Body as notes**: text already in the editor is passed in as must-include notes.

### Generation rules
- Grounded in the form + notes + chosen projects. Must not invent facts about the receiver or the user.
- Two variants that differ in angle, each with its own subject. Regenerate both, or one while keeping the other.
- LLM task `outreach` routing; one call returns both variants as structured JSON.

### Editor + send
- To / Subject / Body editable after picking. Attachments: upload (10 MB each), or attach a rendered resume from the library.
- Pre-send checks: blocking — To missing/invalid, contact inside cooldown; warnings — mentions an attachment but none attached, leftover `{{…}}`/`[…]` placeholders, empty subject.
- Send now, or Schedule (date/time) → Gmail draft for the Apps Script.

### Sent-mail log (`sent_emails`)
- Written by the core on every send outcome: `sent`, `dry_run` (compose only), `scheduled`, `cancelled`, `failed`.
- Columns: recipient, subject, body, attachments (filename, type, size, sha256, kept path), from address, Gmail message/thread/draft ids, Message-ID, review item, contact/company/job/thread, source kind, `input` (compose form + variants + chosen + final), `original` (as generated, before edits), scheduled-for, sent-at. Reply/bounce state joins from `outreach_threads`.
- Compose attachments are copied to `data/compose-attachments/` (gitignored) so the log keeps them.

### API
- `POST /api/compose/generate` → `{ variants: [{ angle, subject, body }, …] }`
- `POST /api/compose/attachments` (one file) → `{ id, filename, size, contentType, sha256 }`
- `POST /api/compose/send` → per recipient: review item id, log id, result (sent / dry run / scheduled / blocked)
- `GET /api/sent-emails`, `GET /api/sent-emails/:id`, `POST /api/sent-emails/:id/cancel` (scheduled only)
- `GET /api/compose/apps-script` → the script to paste into script.google.com

### Later (not in this phase)
Fact-check highlighting, email finder, undo-send delay, auto follow-up for compose mails, saved templates with reply rates.

## Done when
- Form → two distinct variants; picking one fills the editor; body notes appear in both.
- A dry-run send with an attachment produces the correct MIME and an approved+executed `compose` review item and a `sent_emails` row with the full input.
- Outreach sends from the send tick also land in `sent_emails`; the migration backfills past sends.
- Cooldown blocks Send; attachment-mention warning shows.
- Scheduling creates a draft with `X-Quarry-Send-At` (fixture-tested), reconcile marks it sent/cancelled; the Apps Script is served and documented.

## New dependencies
None (`@fastify/multipart` is already in `apps/server`).
