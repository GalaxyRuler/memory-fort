# Consolidation Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make compile execution create, append, normalize, merge, and report page operations correctly so missing project pages are preserved instead of dropped.

**Architecture:** Add a shared slug helper that normalizes only wiki page basenames, then preprocess page-targeting compile operations into normalized per-target operations before grounding/apply. Extend apply results with structured outcomes and surface those outcomes in CLI/dashboard summaries while keeping index/log operations unchanged.

**Tech Stack:** TypeScript, Vitest, Node file APIs, React.

---

### Task 1: Append Missing Page Creates

**Files:**
- Modify: `src/compile/execute.ts`
- Test: `test/compile/execute.test.ts`

- [x] Write a failing test for `append_page wiki/projects/iAqar.md` on an empty vault creating `wiki/projects/iaqar.md` with proposed compile frontmatter and preserved section body.
- [x] Run `npm test -- test/compile/execute.test.ts`.
- [x] Implement missing-page append as a write/create operation with inferred type for known wiki categories and low/high confidence gating.
- [x] Rerun the test.

### Task 2: Shared Slug Normalization

**Files:**
- Create: `src/storage/slug.ts`
- Modify: `src/consolidate/entity-dedup.ts`
- Modify: `src/compile/execute.ts`
- Test: `test/compile/execute.test.ts`

- [x] Write failing tests proving `wiki/projects/iAqar.md` normalizes to `wiki/projects/iaqar.md` while `index.md` and `log.md` stay unchanged.
- [x] Extract `kebabCase` into `src/storage/slug.ts` and normalize only basename-without-`.md`.
- [x] Rerun targeted tests.

### Task 3: Per-Page Operation Merge

**Files:**
- Modify: `src/compile/execute.ts`
- Test: `test/compile/execute.test.ts`

- [x] Write a failing test for write+append targeting the same normalized path producing one create with both bodies.
- [x] Implement safe write+append and append+append merging; ambiguous duplicate writes keep first and report the duplicate as skipped/merged outcome.
- [x] Rerun targeted tests.

### Task 4: Structured Outcomes

**Files:**
- Modify: `src/compile/execute.ts`
- Modify: `src/cli/commands/compile.ts`
- Modify: `src/dashboard/auto-promote-scheduler.ts`
- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard-ui/hooks/useCompileState.ts`
- Modify: `src/dashboard-ui/components/CompilePage.tsx`
- Test: `test/compile/execute.test.ts`
- Test: `test/cli/commands/compile.test.ts`
- Test: `test/dashboard-ui/components/compile-page.test.tsx`

- [x] Write failing tests for outcomes containing path, outcome, reason, contentPreserved, and dashboard/CLI output showing per-op details.
- [x] Extend result types and summaries with `outcomes`, `opsRejected`, and readable labels.
- [x] Rerun targeted tests.

### Task 5: Prompt Guidance

**Files:**
- Modify: `templates/prompts/compile.md`
- Test: focused text check if present, otherwise `rg`.

- [x] Update prompt to require write-for-new, append-for-existing, lowercase-kebab slugs, and one op per page.

### Task 6: Docs and Final Verification

**Files:**
- Modify: `docs/MEMORY-FORT-SPEC.md`
- Modify: `templates/schema.md`
- Modify: `docs/ROADMAP.md`

- [x] Document append-create fallback, slug normalization, and structured outcomes.
- [x] Run focused tests, `npm run typecheck`, `npm run build`, `npm run build:ui`, and `git diff --check`.
- [ ] Commit six slices using the brief's messages and author/trailer.
