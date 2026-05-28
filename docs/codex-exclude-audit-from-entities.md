# Codex Implementation Brief — Exclude `.audit/` from Entity Enumeration (Phase 4.3.Q)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

Live testing of the Phase 4.3.N entity-dedup (2026-05-28) exposed the **actual** root cause of the failing `graph.duplicate-entities` health check — and it is NOT real entity-name drift. It's that **operational audit-log files under `wiki/.audit/` are being counted as wiki entities.**

`memory entity dedup --plan` against the live vault proposed 33 merges. **32 of 33 were `.audit/` files:**

```
wiki/.audit/procedure-propose-2026-05-28T00-17-31-784Z.md <- [wiki/.audit/procedure-propose-2026-05-28T00-20-33-873Z.md] (exact-normalized)
wiki/.audit/thread-propose-2026-05-28T00-15-42-749Z.md <- [wiki/.audit/thread-propose-2026-05-28T01-05-02-622Z.md] (exact-normalized)
... (30 more like this)
```

Only **1** of the 33 was a real candidate (`enhancements-and-testing-for-iaqar-website` vs `...-website-2`).

### Why it happens

`metricDuplicateEntities()` in `src/dashboard/graph-health.ts` (~line 121) buckets `input.wikiPages` by `normalizeTitle(page.title)`. Every `.audit/` log file carries a generic frontmatter title:

- all `procedure-propose-*.md` → title `"procedure propose audit"`
- all `thread-propose-*.md` → title `"thread propose audit"`
- all `consolidate-*.md` → title `"consolidate audit"`

So 6 procedure-propose audits bucket together → C(6,2) = 15 false pairs; 7 thread-propose audits → C(7,2) = 21; plus consolidate → ~33 total. None are real duplicate entities — they're timestamped operational logs that legitimately share a title.

The codebase **already has the exclusion convention** — `.audit/` is filtered in `src/consolidate/bm25-augment.ts:25`, `src/consolidate/title-index.ts:44`, and `src/consolidate/runner.ts:100`. The graph-health input assembly and the new entity-dedup enumeration simply don't apply it.

### Impact

- The only red health check (`graph.duplicate-entities`) is a **false positive** caused by audit-log pollution
- The Phase 4.3.N entity-dedup, if applied, would have proposed merging audit logs — **corrupting the audit trail.** The two-stage review gate caught it; nothing was merged
- Every other graph-health metric that iterates `wikiPages` may also be skewed by `.audit/` files

This brief excludes `.audit/` (and any `wiki/.<dir>/` dot-directory) from entity enumeration at the source, so the health check and the dedup both see only real wiki entities.

---

## Scope guard

You will:

### Task 1 — Exclude `.audit/` from the graph-health input

- Find where `GraphHealthInput.wikiPages` is assembled (the caller of `metricDuplicateEntities` and the other metrics — likely in `src/dashboard/graph-health.ts` or `src/dashboard/loaders.ts` where the health input is built)
- Filter out any page whose `relPath` starts with `wiki/.audit/` — or more generally, any path segment under `wiki/` that begins with `.` (dot-directory). Match the existing convention: `!relPath.startsWith("wiki/.audit/")` at minimum; a `wiki/.` general guard is better
- Apply the filter once at the input-assembly boundary so **all** graph-health metrics benefit, not just duplicates. Confirm `metricDuplicateEntities`, project-density, orphan-rate, participation, provenance, etc. all read the filtered set
- After this, re-running the duplicate check against the live vault should drop from 33 pairs to ~1 (the real iAqar thread pair), flipping `graph.duplicate-entities` from **fail** to **pass** (threshold: warn ≥ 3, fail ≥ 10; 1 pair = pass)

### Task 2 — Exclude `.audit/` from entity-dedup enumeration

- In `src/consolidate/entity-dedup.ts`, exclude `wiki/.audit/` (and `wiki/.<dir>/`) entities when enumerating candidates. Reuse the same guard
- `memory entity dedup --plan` against the live vault should then propose only real candidates (expected: the single `iaqar-website` / `iaqar-website-2` pair, if anything)

### Task 3 — Regression tests

- Add a test in the graph-health test file: an input containing `.audit/` pages with identical titles produces **zero** duplicate pairs from those audit pages
- Add a test in `test/consolidate/entity-dedup.test.ts`: `.audit/` files are not enumerated as dedup candidates
- These tests lock the exclusion so a future refactor can't silently re-include `.audit/`

### Task 4 — Docs

- `templates/schema.md`: note that `wiki/.audit/` is operational-log space, excluded from entity/graph-health enumeration (it's already excluded from search corpus + title index — document the convention in one place)
- `docs/ROADMAP.md`: Phase 4.3.Q shipped 2026-05-28 — fixes the duplicate-entities false positive

You will **not**:

- Change the `metricDuplicateEntities` algorithm itself (bucketing + Levenshtein is fine once the input is clean)
- Change the audit-log titles. The generic titles are fine; they just shouldn't be enumerated as entities
- Delete or move any `.audit/` files
- Change the entity-dedup merge primitive or CLI from Phase 4.3.N — only the enumeration scope
- Apply any of the 33 currently-proposed merges. After this lands, re-plan and review fresh
- Add `.audit/` exclusion to places that legitimately need audit files (the `intent-classifier` verify check reads `wiki/.audit/llm-*.md` on purpose — don't touch that)

If, after excluding `.audit/`, the duplicate count is still ≥ 3 (warn) from real entities, that's legitimate drift for the operator to resolve via `memory entity merge` — **do not** auto-merge or change thresholds to force a pass. The goal is an honest count, not a green light.

---

## Repo orientation

- `src/dashboard/graph-health.ts` ~line 121 — `metricDuplicateEntities`; and wherever `GraphHealthInput.wikiPages` is populated (trace the caller)
- `src/dashboard/loaders.ts` — likely builds the graph-health input from the vault; the filter may belong here
- `src/consolidate/bm25-augment.ts:25`, `title-index.ts:44`, `runner.ts:100` — the existing `.audit/` exclusion convention to copy
- `src/consolidate/entity-dedup.ts` (Phase 4.3.N) — entity enumeration to filter
- `test/dashboard/graph-health.test.ts` (or wherever graph metrics are tested), `test/consolidate/entity-dedup.test.ts` — test homes

---

## Acceptance contract

1. `.audit/` pages are excluded from `GraphHealthInput.wikiPages` at the assembly boundary; all metrics see the filtered set
2. `memory verify` shows `graph.duplicate-entities` as **pass** (expected ~1 real pair after the fix, below the warn=3 threshold)
3. `memory entity dedup --plan` proposes only real entity candidates — no `.audit/` files
4. Regression tests confirm `.audit/` pages produce zero duplicate pairs and are not dedup candidates
5. The `intent-classifier` verify check still reads `wiki/.audit/llm-*.md` correctly (untouched)
6. Full test suite passes; `npm run build`, `npm run build:ui` pass; `git diff --check` clean

---

## Verification commands

```powershell
cd C:\CodexProjects\memory-system
node dist/cli.mjs entity dedup --plan          # should now list ~1 real pair, no .audit files
node dist/cli.mjs verify --role=server | Select-String "duplicate-entities"   # should now PASS
```

---

## Commit boundaries

- Task 1: `fix: exclude wiki/.audit from graph-health entity enumeration (Phase 4.3.Q Task 1)`
- Task 2: `fix: exclude wiki/.audit from entity-dedup candidates (Phase 4.3.Q Task 2)`
- Task 3: `test: .audit pages are not entities (Phase 4.3.Q Task 3)`
- Task 4: `docs: .audit is operational-log space, not entity space (Phase 4.3.Q Task 4)`

---

## Out-of-scope follow-ups

- The single real `iaqar-website` / `iaqar-website-2` thread near-duplicate — operator decides via `memory entity merge` after this lands; not auto-resolved here
- The compile-is-prompt-only limitation (compile generates a prompt artifact rather than autonomously mutating wiki pages) — separate architectural brief
- `.audit/` log rotation — separate housekeeping brief
