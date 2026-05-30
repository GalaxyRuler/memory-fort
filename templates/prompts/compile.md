# `memory compile` — distill raw observations into curated wiki pages

You are running the compile workflow inside the user's active agent session. The CLI emitted this prompt with several context blocks substituted in (`{{schema_content}}`, `{{index_content}}`, `{{existing_pages}}`, etc.). Your job is to read those, then use your file-editing tools to update the wiki in `~/.memory/wiki/`.

You do the entire compile pass in this session. Do not call out to another agent. Do not return a "here's what I would do" plan — actually do the work.

When this prompt is run by `memory compile --execute`, the system message will
ask for an automated operation response. In that mode, do not describe the work
in prose and do not assume file-editing tools are available. Return exactly one
fenced `compile-ops` JSON block:

```compile-ops
{
  "operations": [
    {
      "kind": "write_page",
      "path": "wiki/lessons/example.md",
      "frontmatter": {
        "type": "lessons",
        "title": "Example",
        "relations": {
          "derived_from": ["raw/2026-05-28/codex-session.md"]
        }
      },
      "body": "One-sentence summary first, then supporting details."
    },
    {
      "kind": "append_page",
      "path": "wiki/projects/example.md",
      "section": "## 2026-05-28 update\n\nNew grounded facts."
    },
    {
      "kind": "append_log",
      "line": "## [2026-05-28T12:00:00.000Z] compile | 2 raw -> 1 update, 1 new page"
    }
  ]
}
```

The executor rejects unsafe paths, strips ungrounded wiki/raw references, redacts
secret-like values, applies high-confidence operations directly, and stages
low-confidence operations under `wiki/compile-proposed/`. The executor rebuilds
`index.md` deterministically after successful execute runs; do not emit
`update_index` operations.

Use `append_page` only when the target page already appears in the current wiki
context and the raw observations add genuinely new facts not already present in
that page body. If the existing page already covers the observations, emit no
page operation for that entity. Use `write_page` when creating a new page that meets the cross-session
threshold. Page targets must be `wiki/<category>/<lowercase-kebab-slug>.md`;
for example, a project called `iAqar` should target `wiki/projects/iaqar.md`.
Prefer one page operation per normalized target path; combine related new
content into the `body` or `section` for that page instead of emitting a
separate write and append for the same page.
The executor normalizes page filename slugs and can convert a missing-page
`append_page` into a staged create proposal, but the best response is to choose
the correct operation up front.
If you emit `write_page` for a path that already exists on disk, the executor
auto-converts it into an appended dated update section. You do not need perfect
knowledge of every existing file, but prefer `append_page` when the current wiki
context already shows the target.

---

## Inputs

### Schema (the controlling document)

The user's memory schema dictates what entity types exist, what edge types relate them, what naming rules apply, and what quality standards each page must meet. Read it before you touch anything.

```
{{schema_content}}
```

### Current wiki index

```
{{index_content}}
```

### Existing wiki pages

Current page bodies for wiki pages most relevant to this pass, capped to fit
the prompt budget. Use this state to decide keep/edit: if a page already covers
the raw observations, emit no operation for it.

```
{{existing_pages}}
```

### Recent log lines

The last ~50 lines of `~/.memory/log.md`. Look for the most recent `## [<date>] compile | ...` entry — that's your "since" cutoff. Don't reprocess raws you've already seen.

```
{{recent_log_lines}}
```

### Raw files to process

```
{{raw_files_list}}
```

### Raw file contents

Each file's contents in order. Files may be truncated to ~10KB each if very long.

```
{{raw_content}}
```

---

## Procedure

Work through these steps in order. Use your `Read`, `Write`, `Edit`, and `Glob` tools (or equivalents in your agent) to do the work.

### Step 1 — Extract entity candidates

For each raw file, identify what entity types it mentions. Entity types per schema:

- `projects` — codebases, services
- `people` — collaborators, users
- `decisions` — specific choices with reasons
- `lessons` — reusable facts learned from incidents
- `references` — external knowledge (papers, blog posts, docs)
- `tools` — software dependencies, services

For each candidate, note:
- The slug (lowercase-kebab-case per schema §4)
- The expected wiki path (`wiki/<category>/<slug>.md`)
- One-sentence summary of why this entity is interesting

### Step 2 — Cross-session signal threshold

Per schema §6: **do not create a wiki page from a single raw session's content.** Wait for the same entity to appear across 3+ raw sessions OR for an explicit user instruction.

For each candidate:
- If the entity already has a wiki page → proceed to Step 3 (update it).
- If it doesn't AND it appears in ≥ 3 distinct raw files in this batch (or across this batch + recent prior sessions visible from `index.md`) → create it.
- If it doesn't AND it's a single-session mention → skip; let it stay in `raw/` until a future compile sees the cross-session signal.

### Step 3 — Update existing pages

For each entity with an existing wiki page:
1. Use the Existing wiki pages block as the current page state.
2. Identify what's new in the raw observations beyond what the page already says.
3. If there are no genuinely new facts, emit no operation for that page.
4. If there are new facts, emit one `append_page` operation with a `## [<YYYY-MM-DD>] update` section.
5. If new relations were observed, include only grounded relation changes in the section body; preserve existing claims.
6. Do NOT rewrite or delete existing content. Append only.

### Step 4 — Create new pages (only when threshold met)

For each entity that crossed the threshold and doesn't yet have a page:
1. Create the file at `wiki/<category>/<slug>.md`.
2. Frontmatter follows the contract from schema §3 — required: `type`, `title`, `created` (today), `updated` (today). Set `status: active`. Set `confidence` based on how certain the content is (0.7 if multi-session direct observation; 0.5 if inferred).
3. First line of body: one-sentence summary (what shows in `index.md`).
4. Body: prose explanation, with `[[wikilinks]]` to related pages where appropriate.
5. `relations:` filled with the typed edges you observed (uses, depends_on, etc. per schema §5).

### Step 5 — Privacy filter

Before writing ANY content (update or create), apply the privacy filter from schema §7:

- Strip API key patterns: `sk-[a-zA-Z0-9_-]{20,}`, `AIza[a-zA-Z0-9_-]{30,}`, `gh[ps]_[a-zA-Z0-9]{36,}`, `Bearer [a-zA-Z0-9_.-]+`.
- Strip credentials in URLs: `https?://[^:]+:[^@]+@`.
- Strip PEM blocks (`-----BEGIN <anything>-----`).
- Replace stripped content with `[REDACTED: <category>]`.

The raw observations stay un-filtered in `~/.memory/raw/` (gitignored). Only wiki/ content gets filtered.

### Step 6 — Leave `index.md` to the executor

Do not edit `index.md` and do not emit `update_index`. The executor regenerates
the index from the canonical wiki tree after successful execute runs.

### Step 7 — Append to `log.md`

Append a single line to `~/.memory/log.md`:

```
## [<YYYY-MM-DD HH:MM:SS>] compile | N raw → M updates, K new pages
```

Where N is the number of raw files processed, M is the number of existing wiki pages updated, K is the number of new wiki pages created.

### Step 8 — Report

At the end of the compile pass, print this structured summary to the user (your final agent response):

```
Compile complete.

Raw files processed: N
Wiki pages updated:  M
Wiki pages created:  K

New pages:
  - wiki/projects/<slug>.md — <title>
  - wiki/lessons/<slug>.md — <title>

Updated pages:
  - wiki/projects/<existing>.md — added X update section
  - ...

Skipped (single-session signal, will reconsider next compile):
  - candidate-entity-1
  - candidate-entity-2
```

---

## Anti-patterns — do NOT do these

- **Do not silently delete contradictions.** If new content disagrees with what an existing page says, add the new content under an `## [<date>] update` section AND add the old page to the new content's `relations.contradicts`. The lint pass surfaces these for human resolution.
- **Do not create a `people/X.md` page from a one-off mention.** Wait for cross-session signal.
- **Do not use marketing language.** "Best-in-class", "state-of-the-art", "robust" — banned per schema §10. State facts.
- **Do not include emojis** unless the user explicitly used them.
- **Do not bypass the privacy filter** to keep a "useful" credential in the wiki. There's no useful credential; rotate it.
- **Do not update `confidence:` to 1.0** without evidence. New claims start at 0.5-0.7.
- **Do not invent relations.** If the raw observations don't establish a `uses` or `depends_on` link, don't write one.
- **Do not rewrite existing wiki content.** Append `## [<date>] update` sections only. Preserve audit trail.
- **Do not update `index.md` manually.** It is deterministic executor output.

---

## What "good" looks like

A successful compile pass:
- Touches a small number of files (probably 1-5 wiki pages per pass)
- Adds new content under dated update sections, never deletes
- Leaves `index.md` to the deterministic rebuild step
- Appends one line to `log.md`
- Produces a structured summary report
- Leaves the wiki in a state that `memory lint --checks-only` would report 0 frontmatter errors and 0 broken links against

If you're tempted to write a page with content that isn't directly supported by what's in the raw observations — stop. Wait for more sessions to confirm.

If a raw observation seems important but doesn't fit the entity categories — note it for the user in your summary report but don't force it into a wiki page.

Now proceed.
