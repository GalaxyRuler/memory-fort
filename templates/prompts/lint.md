# `memory lint` — wiki health check
<!-- memory:template lint:2026-05-31-curate-refinement -->

You are running the lint workflow inside the user's active agent session. Your job is to scan the wiki and produce a `lint-report.md` documenting any structural issues. The CLI emitted this prompt with the schema and recent log context substituted.

You do the entire scan in this session. Use your file-reading tools (`Read`, `Glob`) to walk the wiki, then `Write` the report.

The CLI also has a `--checks-only` mode that runs the same checks programmatically (no LLM). Your value-add over that mode is judgment: distinguishing real issues from intentional edge cases, suggesting concrete next steps per issue, and grouping related issues.

---

## Inputs

### Schema (the controlling document)

```
{{schema_content}}
```

### Recent log lines

```
{{recent_log_lines}}
```

---

## Procedure

### Step 1 — Enumerate wiki pages

Use `Glob` with pattern `~/.memory/wiki/**/*.md` to list every wiki page. Also include `~/.memory/crystals/*.md` if any exist (crystals follow the same frontmatter contract).

### Step 2 — Per-page checks

For each page, read it and check:

#### A. Frontmatter validity

Required fields per schema §3: `type`, `title`, `created`, `updated`.

Invalid if:
- Any required field missing
- `type` is not one of: projects, people, decisions, lessons, references, tools, crystal, raw-session
- `created` or `updated` not in ISO 8601 `YYYY-MM-DD` format
- `status` (if present) not one of: active, archived, superseded
- `confidence` (if present) not a number between 0 and 1
- `tags` (if present) not an array of strings
- `relations:` keys not from the 9 known edge types (uses, depends_on, supersedes, contradicts, caused_by, fixed_by, derived_from, mentioned_in, linked)

#### B. Broken `[[wikilinks]]`

Scan the body for `[[<target>]]` patterns. For each:
- If `target` resolves to a wiki page (either filename-only or relative-path form) → OK.
- Else → broken link.

#### C. Broken `relations:` targets

For each entry in `relations.<key>: [target, ...]`:
- If `target` resolves to a wiki page → OK.
- Else → broken relation.

#### D. Stale active pages

If `status: active` AND `updated > 180 days ago` → flag as potentially stale.

#### E. Low-confidence drafts

If `confidence < 0.5` AND `status: active` → flag as DRAFT.

### Step 3 — Whole-wiki checks

After per-page scanning, compute:

#### F. Orphan pages

A page is an orphan if:
- Zero inbound `[[wikilinks]]` from other pages, AND
- Zero inbound `relations:` references from other pages.

The `index.md` itself doesn't count as a containing reference — we want real cross-page links.

#### G. Unresolved contradictions

For each page with `relations.contradicts: [X, Y]` entries:
- If page X also has page A in its `relations.contradicts` → bidirectional, acknowledged but unresolved → flag.
- If page X does NOT reference A back → one-sided contradiction; needs the other side to acknowledge.

### Step 4 — Write `lint-report.md`

Write `~/.memory/lint-report.md` with this structure:

```markdown
# Lint report — <YYYY-MM-DD HH:MM:SS>

## Summary

Pages scanned: N
Issues found:  M
  - Frontmatter errors:    F
  - Broken links:          L
  - Broken relations:      R
  - Stale pages:           S
  - DRAFT pages:           D
  - Orphan pages:          O
  - Unresolved contradictions: C

## Frontmatter errors (F)

### <wiki/path/page.md>
- Missing required field: `<field>`
- Invalid `type` value: `<value>` (must be one of …)
- ... suggested fix: <one line>

## Broken links (L)

### <wiki/path/page.md>
- Line N: `[[<target>]]` does not resolve. Did you mean `<closest-match>`?

## Broken relations (R)

### <wiki/path/page.md>
- `relations.uses` references `<target>` which doesn't exist as a wiki page

## Stale pages (S)

### <wiki/path/page.md>
- `status: active` but `updated: 2025-09-12` (over 180 days ago). Consider: archive, supersede, or update.

## DRAFT pages (D)

### <wiki/path/page.md>
- `confidence: 0.4` — content tentative. Promote to ≥ 0.5 with evidence, OR explicitly mark `status: archived`.

## Orphan pages (O)

### <wiki/path/page.md>
- No inbound `[[wikilinks]]` or `relations:` references from any other wiki page.
- Consider: link from a project / decision / lesson page, OR delete if no longer relevant.

## Unresolved contradictions (C)

### <wiki/path/page-A.md> ↔ <wiki/path/page-B.md>
- Page A's `relations.contradicts` lists page B, but page B does not reciprocate.
- OR: bidirectional, but no resolution decision recorded yet.
- Suggested: add a decision page that resolves them, OR mark one as `status: superseded`.
```

If a category has zero issues, omit that section from the report.

### Step 5 — Append to `log.md`

Append:

```
## [<YYYY-MM-DD HH:MM:SS>] lint | N scanned, M issues (F+L+R+S+D+O+C)
```

### Step 6 — Final agent response

After writing the report, print to the user:

```
Lint complete.

Pages scanned: N
Issues found:  M

Report at: ~/.memory/lint-report.md
Run: code "~/.memory/lint-report.md" to review.

Top issues to address first (your judgment, ≤ 5):
  1. <wiki/path/x.md> — <one-line summary>
  2. ...
```

The "Top issues to address first" list is YOUR judgment call. Prioritize:
- Frontmatter errors (block other automation)
- Broken relations (data integrity)
- Unresolved contradictions (knowledge integrity)
- Orphan pages on `status: active` (probably forgotten)

De-prioritize:
- Old archived pages going stale (they're archived; intentional)
- DRAFT pages the user clearly hasn't promoted yet (intentional)

---

## What "good" looks like

A complete lint pass:
- Reads every wiki + crystal page once
- Produces a structured report covering all 7 issue categories
- Picks 0-5 top issues with concrete next-step suggestions
- Appends one summary line to log.md
- Doesn't modify any wiki page directly (lint is read-only — the user fixes issues, or runs compile to update)

If the report would be empty (truly clean wiki), still write the report with an empty summary so there's evidence lint ran. Don't skip the file.

---

## Anti-patterns — do NOT do these

- **Do not auto-fix issues.** Lint is read-only. The user reads the report and decides.
- **Do not delete pages flagged as orphan.** They might be intentional notes the user hasn't linked yet.
- **Do not modify frontmatter to "correct" what looks invalid.** The check might be wrong; let the user resolve.
- **Do not invent relations to "fix" broken ones.** If a `relations.uses` target doesn't exist, that's data to surface, not data to make up.
- **Do not flag every DRAFT as urgent.** Drafts are intentional; surface them but don't shout.

Now proceed.
