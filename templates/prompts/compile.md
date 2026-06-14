# `memory compile` — distill raw observations into curated wiki pages
<!-- memory:template compile:2026-06-14-core-preferences -->

You are running the compile workflow inside the user's active agent session. The CLI emitted this prompt with several context blocks substituted in (`schema_content`, `index_content`, `existing_pages`, etc.). Your job is to read those, then use your file-editing tools to update the wiki in `~/.memory/wiki/`.

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
      "path": "wiki/threads/example-thread.md",
      "section": "## 2026-05-28 update\n\nNew chronological event."
    },
    {
      "kind": "rewrite_page",
      "path": "wiki/projects/example.md",
      "frontmatter": {
        "type": "projects",
        "title": "Example",
        "confidence": 0.9,
        "relations": {
          "derived_from": ["raw/2026-05-28/codex-session.md", "raw/2026-05-28/manual-session.md"]
        }
      },
      "body": "Complete curated page body preserving existing facts and integrating new facts."
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
`update_index` operations. For `rewrite_page`, the executor archives the prior
page under `wiki/.history/` before writing and stages rewrites that may drop
salient fact anchors such as relations, wikilinks, code identifiers, or entity
names.

For a durable knowledge page with an existing page (`projects`, `lessons`,
`decisions`, `references`, `tools`, `people`, `issues`, or `prospective`), you MUST use
`rewrite_page`: read the injected current page body, preserve all substantive
existing content, integrate genuinely new facts, remove redundancy, and emit the
complete coherent body. Do not emit dated `append_page` sections for these
knowledge pages; the executor rewrites them through a second guarded LLM pass if
you do. Use `append_page` only for chronological surfaces such as `threads` and
`log.md`, where dated history is the point. If the existing page already covers
the observations, emit no page operation for that entity. Use `write_page` only
when creating a new page that meets the cross-session threshold. Page targets
must be `wiki/<category>/<lowercase-kebab-slug>.md`;
for example, a project called `Acme` should target `wiki/projects/acme.md`.

**Issue pages (`wiki/issues/<slug>.md`) — threshold exemption.** A bug,
blocker, incident, failure, or constraint with concrete evidence justifies an
issue page from a SINGLE session — the cross-session threshold exists to
prevent premature entity pages, not to suppress incident records. Route by
state: an unresolved or recurring failure (or one whose cause/fix state is
worth tracking) → `issues`; a resolved incident whose only remaining value is
its reusable takeaway → `lessons`. When an issue page's failure later proves
resolved, record the fix on the issue page (relations: `fixed_by`) rather than
deleting it.

**Core memories (`cognitive_type: core`) — threshold exemption for explicit
directives.** Reserve `core` for durable identity-level facts about the user:
stable preferences, standing constraints, long-lived conventions (e.g. "always
test on temp vaults, never the real one"). Actively scan `## [..] Prompt`
blocks for operator directives — phrases like "always X", "never Y", "from now
on", "make sure you always", "I want you to always". An explicit directive
stated ONCE with durable intent justifies a core memory immediately — create a
page at `wiki/preferences/<kebab-slug>.md` using `write_page`; the cross-session
threshold applies to INFERRED preferences (behavior patterns never stated as a
rule), not to explicit instructions. Inferred preferences still need 3+ sessions
of evidence. Entity/knowledge pages are NOT core — when classifying a page that
is about a project, tool, or event rather than the operator, use `semantic`.

Core memory frontmatter must include: `type: "preferences"`, `cognitive_type:
"core"`, `source: "compile-execute"`, a `confidence` (0.9+ for multi-session or
strongly-stated directives, 0.7 for a single explicit statement), and `tags`
drawn from [preference, constraint, convention, identity, workflow,
communication]. If a directive updates an existing `wiki/preferences/` page
(visible in the existing-pages context), use `rewrite_page` to integrate it.
Merge related directives into one page rather than creating near-duplicates.
Prefer one page operation per normalized target path; combine related new
content into the `body` or `section` for that page instead of emitting a
separate write and append for the same page.
The executor normalizes page filename slugs and can convert a missing-page
`append_page` into a staged create proposal, but the best response is to choose
the correct operation up front.
If you emit `write_page` or `append_page` for an existing durable knowledge page
with prose, the executor either skips it when already covered or rewrites the
whole page through the guarded rewrite path when an LLM is available. Without an
LLM, it stages the operation for review instead of appending. You do not need
perfect knowledge of every existing file, but use `rewrite_page` when the
current wiki context already shows the target.

### Lifecycle Mutation Operations (staged for review)

When you detect that new observations **contradict** or **supersede** existing wiki content, you may emit these operations. All lifecycle mutations are **staged for review** — they write proposals to `wiki/compile-proposed/`, not directly to wiki pages.

#### dispute_page

Use when two claims are **mutually incompatible** — both cannot be true simultaneously.

```json
{
  "kind": "dispute_page",
  "path": "wiki/people/user-location.md",
  "conflicting_page": "wiki/people/user-location-new.md",
  "reason": "Mutually incompatible claims about user location"
}
```

Requirements:
- The existing page and new observation must be about the **same entity**
- The claims must be **mutually exclusive** (not just different aspects)
- You must provide a clear `reason` explaining why both cannot be true

#### supersede_page

Use when old information was **once true but is now obsolete**.

```json
{
  "kind": "supersede_page",
  "old_page": "wiki/tools/python-version.md",
  "new_page": "wiki/tools/python-version.md",
  "reason": "Python version upgraded from 3.10 to 3.12",
  "valid_to": "2026-06-01"
}
```

Requirements:
- The old claim must have been valid at some point
- The new observation must establish a clear temporal succession
- Include `valid_to` if a specific date is identifiable

**Important:** Do NOT use dispute or supersede for information that merely expands or adds detail to an existing page. Use `rewrite_page` for those cases. Lifecycle mutations are for genuine conflicts only.

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

**Exception — issue pages.** A concrete bug, blocker, incident, or failure with
evidence (error text, root cause, or fix) justifies a `wiki/issues/` page from a
single session. Incidents usually happen exactly once; the threshold would
suppress them entirely.

For each candidate:
- If the entity already has a wiki page → proceed to Step 3 (update it).
- If it doesn't AND it appears in ≥ 3 distinct raw files in this batch (or across this batch + recent prior sessions visible from `index.md`) → create it.
- If it doesn't AND it's a single-session mention → skip (unless it's an evidenced issue, per the exception above); let it stay in `raw/` until a future compile sees the cross-session signal.

### Step 3 — Update existing pages

For each entity with an existing wiki page:
1. Use the Existing wiki pages block as the current page state.
2. Identify what's new in the raw observations beyond what the page already says.
3. If there are no genuinely new facts, emit no operation for that page.
4. If the target is a durable knowledge page, emit one `rewrite_page` operation containing the complete curated body: preserve prior facts, integrate new facts, remove duplicate dated sections, and keep the page readable. Do not use `write_page` or `append_page` for an existing durable knowledge page.
5. If the target is a chronological page such as a thread, emit one `append_page` operation with a `## [<YYYY-MM-DD>] update` section.
6. If new relations were observed, include only grounded relation changes and preserve existing claims.

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
- **Do not drop existing facts in a rewrite.** `rewrite_page` is a consolidation of existing page state plus new facts, not a replacement summary.
- **Do not use dated update sections for routine recurring knowledge.** Use `rewrite_page` instead.
- **Do not update `index.md` manually.** It is deterministic executor output.

---

## What "good" looks like

A successful compile pass:
- Touches a small number of files (probably 1-5 wiki pages per pass)
- Keeps hot entity pages coherent with `rewrite_page` and uses dated update sections only for real events
- Leaves `index.md` to the deterministic rebuild step
- Appends one line to `log.md`
- Produces a structured summary report
- Leaves the wiki in a state that `memory lint --checks-only` would report 0 frontmatter errors and 0 broken links against

If you're tempted to write a page with content that isn't directly supported by what's in the raw observations — stop. Wait for more sessions to confirm.

If a raw observation seems important but doesn't fit the entity categories — note it for the user in your summary report but don't force it into a wiki page.

Now proceed.
