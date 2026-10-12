# Phone fetcher

Fetching hundreds of job boards is the slow, always-on part of Quarry. The phone fetcher (`apps/fetcher`) does just
that on a device that is on all the time — an Android phone under Termux — while everything else (matching,
tailoring, outreach, applying) stays on the laptop.

It runs the same source plugins, rate limits and normalizer as the laptop, applies the hard filters from your
`preferences.yaml`, and writes what passes into an outbox the laptop will import. No database, no LLM, no browser.

> Status: the fetch side is done. The laptop-side import and the phone↔laptop sync are the next part; until then
> the batches just accumulate in the outbox.

## Run it

```sh
pnpm fetcher run                       # every board once (data/companies.seed.csv, profile/preferences.yaml)
pnpm fetcher run --every 6             # keep going: one pass every 6 hours
pnpm fetcher run --ats workday --company nvidia --verbose
pnpm fetcher run --no-filter           # keep every posting
pnpm fetcher run --full                # resend postings already sent
pnpm fetcher status                    # last run, batches waiting
```

Defaults: board list `data/fetcher/boards.json` if present, else `data/companies.seed.csv`; preferences
`profile/preferences.yaml`; outbox and state under `data/fetcher/` (`--data` to move them). Plugin settings come
from `config.yaml` `plugins.<id>` if there is one, like on the laptop.

## What it writes

One file per board fetch in `data/fetcher/outbox/`, named by start time so a directory listing is the import
order. Schema: `apps/fetcher/src/batch.ts` (`kind: quarry.fetch-batch`, `version: 1`).

- `postings`: new or changed postings that passed the filter, in full (the raw posting the laptop's importer runs
  through the normal normalize → dedup path).
- `unchanged`: ids of passing postings already sent and not changed since — so the laptop can mark them as seen
  without the phone resending descriptions every pass.
- `filtered`: id, title and reason for everything the preferences dropped.
- `ok` / `error` / `permanent`: a failed fetch writes a batch with no postings; a 404 board is `permanent`.

`data/fetcher/state.json` remembers what was sent per board. Delete it (or use `--full`) if the laptop's database
was reset and needs everything again.

## Phone setup (Android, Termux)

1. Install Termux from F-Droid, then `pkg install nodejs-lts git` and `npm i -g pnpm`.
2. Clone the repo and install only what the fetcher needs:
   `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm i --filter @quarry/fetcher...`
3. Copy `profile/preferences.yaml` from the laptop (and `config.yaml` if you set plugin options).
4. Keep it alive: `termux-wake-lock`, turn off battery optimisation for Termux, leave the phone on a charger.
5. `pnpm fetcher run --every 6`.
