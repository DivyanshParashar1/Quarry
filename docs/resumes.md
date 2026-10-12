# Resumes

Quarry renders a **library** of one-page resumes up front, then for each job picks the best one and rewrites
only its *Technical Skills* section for that job's description. Bullet content is never rewritten (apart from
guardrailed shortening to fit one page), so every line on a resume is something you wrote.

Requires `latexmk` (TeX Live) on `PATH`. Your resume source lives in `profile/resume/` ([profile.md](profile.md#resume--your-resume-as-blocks)).

## The library

```bash
pnpm quarry resumes generate            # render combos + base resumes
pnpm quarry resumes generate --retire   # scrap the current library and regenerate
pnpm quarry resumes list [--all]        # with benchmark averages
pnpm quarry resumes bench [--pick]      # ATS-score the library against the benchmark JDs
```

- **Combos.** Every subset of exactly `resumes.projectsPerResume` (3) project blocks is rendered, with the
  always-included blocks (header, education, experience, skills, extras). Each combo's Technical Skills are
  tailored to *its own projects* (one LLM call per combo).
- **Base resumes.** Each `profile/resume/base/*.yaml` is a fixed selection rendered with your original skills.
- **Retiring** keeps the rows and PDFs so past sends still resolve; retired entries just stop being chosen.

The **Resumes** tab shows the library, the benchmark matrix and the *Scrap & regenerate* button.

### Benchmarks

Categories (default *SWE intern* and *AI/ML engineer*) each get `benchmarks.perCategory` (5) real JDs picked
from your jobs by title keywords and match score; you can swap them on the Resumes tab. Every library resume
is ATS-scored against every benchmark JD under every ATS profile. Averages break ties during selection.

## Picking a resume for a job

```bash
pnpm quarry tailor <jobId>            # reuse an earlier decision if there is one
pnpm quarry tailor <jobId> --force    # re-pick and rerun the skills rewrite
```

1. Every non-retired library resume is scored against the job's JD:
   `0.4 × similarity + 0.6 × ATS score`, where similarity is the embedding cosine mapped 0.5 → 0, 0.9 → 100.
   The best wins (deterministic, no LLM). Below `selector.threshold` (75) the decision is flagged *weak fit*.
2. The winner's Technical Skills are rewritten for the JD (one LLM call). Allowed items are your original
   skills plus anything in the selected projects' `tech_stack_line`; anything else is rejected.
3. The result is re-fit to one page and re-scored. It is **kept only if its ATS score for this job is at least
   the combo's**; otherwise the combo is used as-is.

With an empty library, a full per-job tailor runs instead. The job page shows the chosen resume, its ATS score
card (matched and missing keywords) and the selector's reasoning.

## ATS score

`packages/core/ats-score` (deterministic, no LLM) extracts text from the compiled PDF and checks:

- **Parsing** — text extractable, sane reading order, recognised section headers, contact info, no
  ligature/encoding breakage, parseable dates.
- **Keyword coverage** — skills and requirements from the JD vs the resume text, with hard requirements
  weighted higher.
- **Per-ATS profile** — Greenhouse, Lever, Ashby, Workday, SmartRecruiters, SuccessFactors, Taleo or generic;
  the job's ATS comes from its board. Workday and Taleo weigh section names, date formats and layout more;
  Greenhouse and Lever are mostly keyword-driven.

Output: score 0–100, parse findings, matched/missing keywords and notes.

## One-page fit

After assembly, `tailor-resume-latex` compiles and, while the PDF is over one page:

1. steps the font size down (10 → 9.5 → 9 pt, floor `fit.minFontPt`);
2. then line spacing (1.0 → 0.97 → 0.94, floor `fit.minLinespread`);
3. then asks the LLM to shorten the longest bullets (`fit.shortenBullets` per round, up to
   `fit.maxShortenRounds`). A shortened bullet that adds a number, proper noun or technology not in the
   original is reverted.
4. still too long → the variant is marked `overflow`, kept but not auto-used, and a review item is raised.

The typography changes go into a `%%FIT%%` slot, so your `preamble.tex` is never edited.

## Where PDFs go

`data/resumes/` (gitignored). Referral messages link or attach the job's chosen resume; application actors
upload it.
