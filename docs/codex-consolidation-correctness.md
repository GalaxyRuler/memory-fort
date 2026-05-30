# Codex Implementation Brief — Consolidation Correctness (Phase 4.16)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.7 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

---

## What this is

The first real `compile --execute` passes (2026-05-29/30) consolidated the plumbing fine but exposed that the **content layer drops the common case**: creating pages for the operator's many not-yet-documented projects (iAqar, VeriTrace, Lisan Studio, legal-ai, Homelab, …). Only 2 of ~10 project pages exist, so most consolidation needs to *create* pages — but the executor and prompt mishandle that.

Five connected defects, all verified in code/runtime:

1. **`append_page` to a non-existent target hard-fails.** `src/compile/execute.ts` (~L184): `if (!existsSync(fullPath)) return { ok: false, reason: "target page does not exist" }`. It never falls back to creating the page, so content for not-yet-existing pages is rejected and surfaced as an error.
2. **No slug normalization.** The model emits `wiki/projects/iAqar.md` (brand casing); the canonical slug is lowercase-kebab `iaqar.md` (schema §4). The executor does an exact-path existence check, so casing alone causes a miss/duplicate. A `kebabCase` helper exists (`src/consolidate/entity-dedup.ts:396`) but isn't used here.
3. **Redundant/conflicting ops per entity.** Observed: the model proposed both a `write_page` for `iaqar` (staged, good content) AND an `append_page` for `iAqar` (failed) in the same run.
4. **Opaque outcome reporting.** Rejections are concatenated into a single `error` string in the summary; the operator sees "target does not exist" and cannot tell that the page's content was actually created/staged elsewhere. (The executor already tracks a structured `rejected: Array<{path, reason}>` — it's just not surfaced clearly.)
5. **(Root) Most pages don't exist yet.** With append-fails on missing pages, consolidation can't bootstrap the project pages it needs — so the backlog never gets documented.

The fix makes consolidation **create-or-append correctly, casing-insensitively, with one op per page and a clear per-op outcome** — so the operator's projects actually get pages.

---

## Scope guard

You will:

### Task 1 — `append_page` to a missing target creates it

- In `src/compile/execute.ts`, when an `append_page` op's (normalized) target page does not exist, **create it** instead of rejecting: treat the `section` as the new page body, synthesize minimal frontmatter (infer `type` from the path's category dir, e.g. `wiki/projects/x.md` → `type: projects`; set `source: compile-execute`, `lifecycle: proposed`, a sensible `confidence`), and write it via the same path as `write_page` (which already refuses to overwrite an existing page — here the page is new, so it's a clean create).
- This create is **confidence-gated** exactly like a `write_page`: high-confidence applies directly; low-confidence stages to `wiki/compile-proposed/`. Never drop the content.
- `append_page` to an **existing** page is unchanged (append the dated section).
- Record the transformation in the op outcome (Task 4): "append→create" so it's visible, not silent.

### Task 2 — Normalize target slugs (casing-insensitive)

- Before the existence check and write, normalize every operation's target path to the canonical form: lowercase-kebab **slug** for the filename, preserving the category directory. Reuse/extract the `kebabCase` helper from `src/consolidate/entity-dedup.ts` into a shared util (e.g. `src/storage/slug.ts`) so the same normalization is used by entity-dedup, compile-execute, and anywhere else that derives a page path. `wiki/projects/iAqar.md` → `wiki/projects/iaqar.md`.
- The existence check, write target, and any relation references must all use the normalized path, so casing can never cause a missed match or a duplicate page.
- Do not rename existing pages; only normalize the *target* of new operations.

### Task 3 — De-duplicate conflicting ops per page

- Within a single compile-execute result, if multiple operations target the **same normalized path** (e.g. a `write_page` and an `append_page` for `iaqar`, or two appends), **merge** them into one coherent operation before applying: a create whose body includes the appended section(s), or a single append. Eliminate the redundant op rather than applying one and rejecting the other.
- If a merge is ambiguous (e.g. two different write_page bodies for the same path), keep the first and record the other as a de-duped/skipped op in the outcome (Task 4) — don't silently drop without recording.

### Task 4 — Clear per-op outcomes (no opaque "error")

- Replace the single `error` summary string with a structured per-op outcome list the run already half-tracks (`rejected[]`): for each operation report `path` + outcome ∈ {`created`, `appended`, `index-updated`, `log-appended`, `staged-for-review`, `merged`, `rejected`} + `reason` (for rejected) + `contentPreserved: boolean`.
- The run summary aggregates these: `opsApplied`, `opsStaged`, `opsRejected`, plus the per-op list. A genuinely rejected op (e.g. path traversal) is the only case with `contentPreserved: false`; "append→create" and "staged" are `contentPreserved: true`.
- Surface this in BOTH the CLI output and the dashboard CompilePage result panel: e.g. "iaqar: created · veritrace: created · 1 staged for review" — never a bare "target does not exist" for content that was actually created/staged.

### Task 5 — Tighten the compile prompt (reduce bad ops at the source)

- In `templates/prompts/compile.md`, make the write-vs-append rule explicit: **"For each page: if its slug appears in the index above, use `append_page`; if it does NOT exist, use `write_page` to create it. Emit page paths as lowercase-kebab slugs (`wiki/projects/iaqar.md`, not `iAqar.md`). Produce at most one operation per page."**
- The executor fixes (Tasks 1-3) are the safety net; the prompt change reduces how often the net is needed.

### Task 6 — Tests + docs

- Tests in `test/compile/execute.test.ts`: `append_page` to a missing target creates it (confidence-gated); a `iAqar.md` op normalizes to and matches `iaqar.md`; a write+append pair for the same normalized path merges into one create; the per-op outcome list reports created/appended/staged/rejected correctly with `contentPreserved`.
- `docs/MEMORY-FORT-SPEC.md` §7 + `templates/schema.md`: document append-creates-when-missing, slug normalization, and the per-op outcome model.
- `docs/ROADMAP.md`: Phase 4.16 shipped.

You will **not**:

- Remove the append-only guarantee for **existing** pages (append still never rewrites existing content).
- Overwrite an existing page (write_page still refuses an existing target; the append→create path only fires when the page is genuinely absent after normalization).
- Auto-promote low-confidence creates — they still stage to `wiki/compile-proposed/` for review.
- Rename or re-slug existing vault pages (normalization applies only to new operation targets).
- Change grounding/secret-redaction (Phase 4.4/4.9) — only the create/append/normalize/report logic.

If merging conflicting ops (Task 3) risks combining genuinely different content incorrectly, **stop and ask** — prefer keeping the first + recording the second as skipped over a lossy merge.

---

## Repo orientation

- `src/compile/execute.ts` ~L162-188 (`applyOperation`: `write_page`/`append_page` cases), ~L47/L100/L120 (the `rejected[]`/outcome tracking + summary).
- `src/consolidate/entity-dedup.ts:396` `kebabCase` — extract to `src/storage/slug.ts` (shared).
- `templates/prompts/compile.md` — write-vs-append rule + slug guidance + one-op-per-page.
- `src/dashboard-ui/components/CompilePage.tsx` — render the per-op outcome list.
- `test/compile/execute.test.ts` — the test home.

---

## Acceptance contract

1. `append_page` to a missing (normalized) target **creates** the page (confidence-gated), never rejects-and-drops.
2. `wiki/projects/iAqar.md` and `wiki/projects/iaqar.md` resolve to the same page; no casing-induced misses or duplicates.
3. A write+append pair for the same normalized page merges into one operation.
4. The run reports per-op outcomes (created/appended/staged/rejected + contentPreserved); the operator never sees a bare "target does not exist" for content that was actually created or staged.
5. The compile prompt instructs write-for-new / append-for-existing + lowercase-kebab slugs + one op per page.
6. Full suite + typecheck green; build + build:ui clean; `git diff --check` clean.

---

## Commit boundaries

- Task 1: `feat: append_page creates the page when the target is missing (Phase 4.16 Task 1)`
- Task 2: `feat: normalize compile-op target slugs (lowercase-kebab) (Phase 4.16 Task 2)`
- Task 3: `feat: merge conflicting compile-ops per page (Phase 4.16 Task 3)`
- Task 4: `feat: per-op compile outcomes; no opaque error string (Phase 4.16 Task 4)`
- Task 5: `feat: compile prompt write-vs-append + slug guidance (Phase 4.16 Task 5)`
- Task 6: `test+docs: consolidation correctness (Phase 4.16 Task 6)`

---

## Context

This is the difference between "the compile button runs" (done) and "the compile button actually documents the operator's projects" (this brief). Without it, every project that lacks a page — i.e. most of them — produces an error and a manual-review item instead of just getting created. After it, the first few passes bootstrap the missing project pages, and subsequent passes append to them.
