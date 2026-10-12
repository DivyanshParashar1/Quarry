# Your profile

Everything Quarry says about you comes from `profile/` (gitignored; create it with
`cp -R profile.example profile`). The system selects, reorders and (in narrow,
guardrailed ways) rephrases it, but never adds to it. After any edit:

```bash
pnpm quarry profile load     # validate + activate (a new profile version)
pnpm quarry embed            # re-embed facts and the profile
pnpm quarry match --rescore  # only if you changed what you're looking for
```

The dashboard's **Profile** tab edits the same data.

## `facts.yaml` — the fact bank

A list of small, factual entries. Matching and resume validation use them; LLM-written text (skills rewrite,
referral messages, application answers) must be grounded in them.

```yaml
facts:
  - id: exp-acme-backend
    kind: experience          # project | experience | education | skill | achievement
    content: Backend engineer at Acme (2022-2024). Built the payments ledger service in Go on Postgres, handling 2M transactions/day.
    metrics: { transactions_per_day: 2000000, years: 2 }
    tags: [go, postgres, payments]
  - id: skill-go
    kind: skill
    content: Go (3 years, production services)
    tags: [go]
```

Rules:

- **Ids are stable.** Never reuse an id for a different fact; a rename is a new id.
- **Put numbers in `metrics` as well as `content`** so validators can check them.
- One claim per fact is easier to ground than a paragraph.

## `preferences.yaml` — what you're looking for

Hard filters drop jobs before any LLM call; the rest feeds the similarity prefilter and the LLM rubric. Empty
lists mean "no filter".

| Key | Example | Used as |
|---|---|---|
| `roles` | `[Backend Engineer, SDE Intern]` | similarity + rubric |
| `seniority` | `[intern]` | hard filter. Levels: intern, junior, mid, senior, staff, principal, lead, manager, director, executive. A title with no level marker counts as mid. |
| `locations` | `[India, Bengaluru, Bangalore]` | hard filter, case-insensitive substring |
| `remote_policy` | `[remote, hybrid, onsite]` | hard filter. With `remote`, a remote job passes when its location names no place or one of yours. |
| `stack` | `[TypeScript, PostgreSQL, React]` | similarity, rubric, keyword-mode score |
| `salary_floor` | `{ amount: 40000, currency: INR, period: month }` | rubric only |
| `experience_years` | `0` | jobs asking for much more are dropped (`experienceSlackYears`, default 2) |
| `graduation_year` | `2027` | jobs restricted to other batches are dropped |
| `keywords.title_any` / `description_any` | `[software, backend, ml]` | hard filter: whole-word, case-insensitive; at least one must appear |
| `exclusions.companies` / `title_keywords` / `description_keywords` | `[sales]` | hard filter |

### The `application` block

Used to fill application forms. **Salary, notice period, work authorization, sponsorship and EEO are only
ever taken from here** — the LLM never answers them. `null` means "leave it for me to fill".

```yaml
application:
  first_name: Asha
  last_name: Rao
  email: asha@example.com
  phone: "+91 98xxxxxxx"
  location: Bengaluru, India
  linkedin_url: https://www.linkedin.com/in/asha/
  github_url: https://github.com/asha
  website_url: null
  current_company: null
  current_title: null
  university: Example Institute of Technology
  degree: B.Tech, Computer Science
  work_authorization: { India: yes, US: no }
  requires_sponsorship: null      # true / false; null = ask me
  notice_period_days: null
  answers:                        # recurring custom questions (substring match on the label)
    - { match: "hear about", answer: "Company careers page" }
  eeo:                            # null = leave for me, "decline" = pick the decline option
    gender: null
    race: null
    hispanic_latino: null
    veteran_status: null
    disability_status: null
    pronouns: null
```

Answers you approve on application drafts are also saved to an **answer bank** and reused for similar
questions (`quarry answers`, Profile → answers). `preferences.yaml` answers always win over the bank.

## `resume/` — your resume as blocks

```
profile/resume/
  preamble.tex        # your document class, packages and macros (user-owned; the fit loop never edits it)
  manifest.yaml       # describes sections and blocks
  blocks/*.tex        # one self-contained fragment per header / education / job / project / skills / extras
  base/*.yaml         # optional fixed selections ("base resumes")
```

### `manifest.yaml`

```yaml
sections_order: [education, experience, projects, skills, extras]

sections:                      # wrapper emitted around each non-empty section
  projects:
    header: "\\section{Projects}"
    inner_start: "\\resumeSubHeadingListStart"
    inner_end: "\\resumeSubHeadingListEnd"
    separator: "\\vspace{-13pt}"   # between adjacent blocks

header_block: header           # always first, outside sections_order

blocks:
  - id: header
    file: blocks/header.tex
    section: header
    always_include: true
  - id: exp.acme
    file: blocks/exp.acme.tex
    section: experience
    title: Acme (Backend Engineer)
    always_include: true
    tags: [backend, go, postgres]
    bullets:
      - { id: exp.acme.b1, tags: [payments, postgres] }
  - id: proj.ledger
    file: blocks/proj.ledger.tex
    section: projects
    title: Ledger
    tech_stack_line: Go, PostgreSQL, Kafka   # skills used here may be surfaced in Technical Skills
    bullets:
      - { id: proj.ledger.b1 }
  - id: skills.default
    file: blocks/skills.default.tex
    section: skills
    always_include: true
```

- Blocks with `always_include: true` (header, education, experience, skills, extras) appear in every resume;
  **project** blocks are what the library varies (see [resumes.md](resumes.md)).
- `tech_stack_line` widens what the skills rewrite may mention: original skills ∪ the selected projects' stacks.
  Anything else is rejected.

### Base resumes

`base/<name>.yaml` is a fixed block selection rendered once with your original skills (no LLM):

```yaml
label: "Base: all blocks"
blocks: [edu.example, exp.acme, proj.ledger, skills.default]
```
