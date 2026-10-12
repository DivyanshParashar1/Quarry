# Autopilot, sweeper and deadlines

Autopilot is what makes Quarry run unattended: it moves each promising job from "matched" to "applied",
fanning out referral asks first. It is **off by default**.

```yaml
# config.yaml
autopilot:
  enabled: true
```

Sends and submissions still need `MODE=live`; applications still wait for you unless
`autoApproveApplications: true`.

## The sequencer (strategy `referrals`)

```
candidate ──► referral_pending ──► ready_to_apply ──► applied
    └──────────────┴──────────────────────┴──► expired | failed
```

1. **Admit** — top matches with score ≥ `minMatchScore` (70) whose resume passed the gates become
   `candidate`, up to `maxConcurrentJobs` (50) in flight.
2. **Fan out** — up to `referralsPerJob` (default `outreach.perJobReferralCap`, 10) asks to distinct people:
   imported contacts first, then LinkedIn connections, then pattern-inferred emails. Each person is asked at
   most once per `perContactCooldownDays` (30). Confident drafts are auto-approved
   (`autoApproveReferrals`, within `maxAutoApprovedAsksPerDay`); others wait in Review. LinkedIn drafts are
   always yours to send by hand. State → `referral_pending`.
3. **Wait** until any of: someone replies (email reply, or you click *They replied*); the inferred deadline is
   within `deadlineImminentDays` (3); `referralWaitDays` (2) have passed since the first ask.
4. **Apply** — an application draft is queued. State → `ready_to_apply`, then `applied` once submitted.
5. Closed postings and passed deadlines → `expired`; repeated failures → `failed`.

Killing the process mid-way is safe: every step is idempotent and resumes without duplicate asks.

```bash
pnpm quarry autopilot [--limit n] [--live]       # one sequencer tick now
pnpm quarry pipeline list [--state referral_pending] [--company Acme]
pnpm quarry pipeline show <jobId>                # full timeline
pnpm quarry pipeline advance <jobId>             # push one step (ready_to_apply → applied = applied by hand)
pnpm quarry pipeline expire <jobId> --reason "role filled"
```

The **Applications** tab shows the same thing.

**Backpressure.** While `maxPendingReviews` (300) review items are pending, no new jobs are admitted and no new
asks fan out; jobs already in flight keep moving.

`strategy: single_email` is the older loop: one tailored email per job, no referral batch.

## The sweeper

One idempotent pass, on server start (`sweeper.runOnStart`) and every `sweeper.intervalMinutes` (60):

| Step | Runs |
|---|---|
| fetch boards older than `fetchEveryHours` (6) · alert emails · reply tracking · deadline expiry | always |
| embed + match (up to `matchLimit`) · resume selection · referral fan-out · the 24 h follow-up · deadline inference · sequencer tick · apply tick | only with `autopilot.enabled` |
| actual sends / submissions | only with `MODE=live` |

It also makes stages trigger each other directly (new job → match → resume → fan-out), so the hourly pass is a
safety net, not the main driver. After days offline, one pass catches up everything due without duplicates.

```bash
pnpm quarry sweep [--live]     # run a pass now
```

## Follow-ups

One follow-up, 24 h after the ask (`outreach.followupDays: [1]`, `maxFollowups: 1`), cancelled by any reply.
Email follow-ups auto-approve under the same confidence gate as asks. LinkedIn follow-ups are drafted for you
and only for sent *messages*; a connection *note* gets no reminder — click **They accepted** when it is accepted
and the full message (with resume) is drafted, which then gets its own follow-up.

## Deadlines

`enricher-deadline` estimates when applications close, using an LLM with web search and citing its sources:

```bash
pnpm quarry deadlines [--job <id>] [--limit n] [--rescore]
```

- Only jobs with match score ≥ `deadlines.minMatchScore` (60); estimates older than `staleDays` (14) are redone.
- A passed deadline closes the job when confidence ≥ `expireMinConfidence` (0.6) and `expireGraceDays` (1)
  have passed.
- The job page shows date, confidence, rationale and sources.
- Set `deadlines.nightly: true` to run it on the server every night (each estimate is one LLM call).

## Auto-approval limits at a glance

| What | Auto-approved when | Budget |
|---|---|---|
| Referral ask (email) | draft confidence ≥ `confidenceFloor.outreach` (0.8) and contact email confidence ≥ `minEmailConfidence` (0.6) | `maxAutoApprovedAsksPerDay` (200) |
| Email follow-up | same gate as asks | same |
| LinkedIn message / note | never — you send it | — |
| Application | only with `autoApproveApplications: true`, and every LLM answer ≥ `confidenceFloor.answers` (0.85) | — |
