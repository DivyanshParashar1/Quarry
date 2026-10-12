# Matching

`matcher-default` scores every open job against your active profile, 0–100, with written reasons.

```bash
pnpm quarry embed                 # embed new/changed jobs, facts and the profile (local model)
pnpm quarry match                 # score unscored open jobs
pnpm quarry match --rescore       # redo everything (after changing preferences)
pnpm quarry match --limit 50 --no-embed
pnpm quarry jobs list             # sorted by score
```

With `autopilot.enabled`, the sweeper matches new jobs automatically (up to `sweeper.matchLimit` per pass).

## Pipeline

1. **Hard filters** (free, deterministic) from `preferences.yaml`: seniority, locations + remote policy,
   graduation year ("batch"), years of experience (with `experienceSlackYears` slack, default 2), title and
   description keyword gates, and exclusions. A filtered job gets a score of 0 and the reason it was dropped.
2. **Similarity prefilter**: cosine similarity between the job's embedding and your profile's. Below
   `minSimilarity` (0.55) the job is not worth an LLM call.
3. **LLM rubric** for the top `llmTopK` (150) survivors, `batchSize` (12) jobs per call, each description cut to
   `descriptionChars` (3000). The rubric scores `stack_fit`, `seniority_fit`, `location_fit` and `eligibility`
   (0–10 each) and writes the reasons you see on the job page.

Results go to `match_results` with the profile version, provider and model, so a profile change is visible as
stale scores.

## Keyword mode (no LLM, no embeddings)

```yaml
plugins:
  matcher-default:
    mode: keywords
    keywordBase: 70      # score of a job that passes every filter
    keywordPerHit: 6     # + this per `stack` keyword found in the posting
```

The hard filters (especially `keywords.title_any` / `description_any`) decide relevance on their own; `stack`
hits only rank the survivors. Useful to get going before an LLM is set up, or to keep costs at zero.

## Tuning

| Symptom | Change |
|---|---|
| Too many irrelevant jobs reach the LLM | tighten `keywords.title_any`, add `exclusions`, raise `minSimilarity` |
| Good jobs score 0 | check the reason on the job page — usually seniority (an untagged title counts as mid), location, or the batch year |
| LLM cost too high | lower `llmTopK`, route `match` to a cheaper model under `llm.tasks.match` |
| Autopilot ignores decent jobs | lower `autopilot.minMatchScore` (70) |
