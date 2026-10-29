# Compose and the Sent log

The **Compose** tab is for writing one personal mail yourself (usually a referral ask), with help. The **Sent** tab is a log of every email Quarry has sent.

## Compose

The left side is a normal mail editor: To, their name, an optional Company, Subject, Body and attachments. The right side is the **Generate** panel:

| Field | What it's for |
|---|---|
| What is it for? | Referral ask, cold intro, follow-up, thank-you, coffee chat. Sets the shape of the request. |
| What is the mail about? | Your words: the role, the req id, why you're writing. |
| About *the receiver* | Your words about this person: who they are, how you know them, what to mention. **This is the only thing the generator knows about them.** Quarry never looks people up. |
| Projects to mention | Tick projects from your profile (`project` facts), plus optional notes on them. |
| Tone, length | Formal / neutral / casual. Short (~90 words), medium (~150), full (~230). |

Anything you type in the **body** before generating is treated as must-include notes. Press **Generate 2 drafts** to get two drafts side by side, each taking a different angle and with its own subject. **Use this one** puts a draft in the editor, where you can keep editing. **Regenerate this one** replaces one draft and keeps the other.

After you pick a draft, your original notes are kept below the editor. They are used for any regeneration and saved in the log.

The rules for the generator: it may only use what you wrote and the projects you ticked. It must not invent anything about the receiver or about you, and it must not leave placeholders such as `[Name]`.

### Several recipients (batch)

Use **Add recipient** to add another person. The new recipient starts from the current mail. Purpose, about, projects, tone and length are shared across the batch. To, name, company, about the receiver and the body are separate for each person. **For all N** generates drafts for every recipient. **Send to N** sends one mail per person: each gets its own review item and its own log row, linked by a batch id. If any recipient is blocked, nothing in the batch is sent.

### Attachments

**Attach file** uploads a file (10 MB max, up to 5 per mail). Uploads are kept in `data/compose-attachments/`, which is gitignored, so the log can always link to them. **Attach a resume…** adds a rendered PDF from the Resumes library.

### Before sending

- **Blocked:** To is missing or invalid; the body is empty; the person is marked bounced or do-not-contact; for a referral ask or intro, the person was already asked within the cooldown (`outreach.perContactCooldownDays`, 30 days); the Gmail sender daily limit would be exceeded; the same address appears twice in the batch.
- **Warnings** (you can **Send anyway**): the body mentions an attachment but nothing is attached; a placeholder like `[Name]` or `{{company}}` is left; the subject is empty.

The cooldown can only apply if Quarry knows the person. It finds them by email address, or creates the contact when you fill in **Company**. Filling in Company also turns on reply tracking for that mail. Thank-yous, follow-ups and coffee chats don't count toward the cooldown.

### Sending is the approval

Pressing **Send** (or **Schedule**) is your approval. Quarry creates one `compose` review item per recipient, already approved by you, and sends it right away through `actor-gmail-outreach`. The send tick's spacing doesn't apply. The usual rules still hold: without `MODE=live`, the page shows **Dry run** and nothing is sent, but the mail is still logged. A compose mail that fails to send is marked failed and is never retried in the background. Resend it from the page.

A signature from `plugins.actor-gmail-outreach.signature` is added to the end of the body.

## Scheduled sending (happens in Google, works with Quarry off)

Gmail's API has no scheduled send, so Quarry saves a scheduled mail as a **Gmail draft** with an `X-Quarry-Send-At` header. A small **Google Apps Script** running in your Google account sends due drafts every 5 minutes. Quarry doesn't need to be running.

One-time setup (the **How scheduling works** link on the Compose page has the script and a Copy button):

1. Run `pnpm quarry gmail auth` once more. Scheduling needs the `gmail.compose` (drafts) permission, which older logins don't have.
2. Open [script.google.com](https://script.google.com/home/projects/create), create a new project, paste the script (also at `GET /api/compose/apps-script`) and save.
3. Choose `install` and press **Run**, then allow access. To stop, run `uninstall`.

The script only touches drafts that carry the Quarry header. To unschedule a mail, delete the draft in Gmail or press **Cancel scheduled send** on the Sent tab. Mails go out within about 5 minutes of the set time.

Quarry finds out what happened on its next hourly sweep (the `scheduled` step, which also runs on server start), and whenever the Sent tab opens:
- the draft is gone and a sent message is in its thread: **Sent**, and reply tracking starts;
- the draft is gone and nothing was sent: **Cancelled**.

## The Sent log

The `sent_emails` table records every email Quarry sends: compose mails, outreach, referral asks and follow-ups from the send tick. Emails sent before this log existed were backfilled by migration `0020`. Each row holds:

- what went out: from, to, subject, body, attachments (filename, type, size, sha256, and the kept file, downloadable from the Sent tab), and the Gmail message, thread and draft ids;
- status: `queued`, `sent`, `scheduled`, `dry_run`, `failed` or `cancelled`, plus the reply or bounce state from the outreach thread;
- for compose mails, **everything you put in**: the form, receiver info, your notes, both drafts you saw, which one you picked, and whether you edited it after picking;
- for outreach mails, how the draft was grounded (fact ids, confidence, who approved it) and the draft before your edits.

API: `GET /api/sent-emails?status=&source=&q=`, `GET /api/sent-emails/:id`, `GET /api/sent-emails/:id/attachments/:n`, `POST /api/sent-emails/:id/cancel`, `POST /api/sent-emails/reconcile`.
