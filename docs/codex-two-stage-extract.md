# Codex Implementation Brief — Two-Stage Consolidation: Extract Facts Before Integrate (Phase 4.27)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Builds on the **uncommitted 4.26 tree changes** (novelty judgment + curate --refresh); do not discard them — complete them.

> Operator decision (2026-05-31): fix the *input*, not just the model. Verified live: `curate memory-system --refresh` fed a raw session transcript — including an unrelated 200-line iAqar UX-assessment prompt — straight into the page rewrite. The model couldn't distill it; the page got a `## Refresh observations` raw dump and the real facts (Phase 3 shipped, dashboard, the 4.x arc) were never integrated. (Reverted.)

---

## Root cause

Consolidation feeds **raw session transcripts** (prompts, tool outputs, unrelated tangents) directly to the page-rewrite LLM and asks it to produce a clean page in one step. `gpt-4o-mini` (any small model, really) can't do extract + filter + integrate simultaneously on noisy input. Every prior failure (over-append, bloat, hollow skip, raw dump) is a symptom of one missing stage: **there is no extraction step that turns a noisy transcript into clean, entity-scoped facts before integration.**

The established fix (researched 2026-05-31) is **two-stage / hybrid extract-then-abstract (map-reduce)**: extract the salient information per chunk first, then synthesize. Sources: [two-stage summarization for long dialogues (arXiv 2410.06520)](https://arxiv.org/html/2410.06520v1), [hybrid extraction→abstractive (Galileo)](https://galileo.ai/blog/llm-summarization-strategies), [map-reduce for long docs (Belitsoft)](https://belitsoft.com/llm-summarization).

---

## The design: extract (map) → integrate (reduce)

**Stage 1 — Extract (per raw session × entity):** an LLM call takes one raw session's text + a target entity and returns a **concise list of salient facts about that entity**, or an explicit **"no relevant facts"** for tangential mentions. This filters noise (tool-output dumps) AND irrelevance (the iAqar UX prompt that merely name-drops memory-system → "no relevant facts").

**Stage 2 — Integrate (per page):** the page-rewrite call receives the current page + the **extracted facts** (never raw transcript text) and produces the updated coherent page (existing 4.25/4.26 rewrite path + fact-coverage guard + `.history` archive + novelty/churn judgment).

Raw transcript text **never reaches the integrate step**.

---

## Scope guard

### Task 1 — Fact extraction (the map stage)
- Add `extractEntityFacts({ rawText, entity, entityContext, llm, maxBytes }) → { facts: string[] } | { facts: [] }`. Prompt: *"From this raw agent-session text, extract only concrete, durable facts about <entity> (decisions made, features shipped, status changes, design choices). Ignore prompts, tool output, and anything not a fact about <entity>. If there are none, return an empty list. Do not invent."*
- Cap input per call (chunk a huge session; map over chunks). Return deduped facts.
- Cache results keyed by `(rawRelPath, byteRange, entity)` in compile-state (or a sidecar) so a drain doesn't re-extract the same session every pass.

### Task 2 — Rewire knowledge-page integration to consume facts, not transcripts
- In the compile knowledge-page rewrite path AND `curate --refresh`: for each relevant raw observation/session, run Stage 1 → collect extracted facts → feed **only the facts** (plus the current page) to the Stage 2 rewrite.
- The rewrite's "new content" input is the fact list, not raw markdown. The `## Refresh observations` raw-dump section in `curate.ts` (≈ line 216) is **removed** — never append raw observations to a page.

### Task 3 — Relevance pre-filter + cost bounds
- Cheap pre-filter before Stage 1: only extract from sessions where the entity name/aliases actually appear (string match) — skip the rest with zero LLM cost.
- Stage 1 returning `[]` (no relevant facts) contributes nothing to Stage 2 — a tangential mention can't pollute the page.
- Surface cost: report `factsExtracted`, `sessionsScanned`, extraction token usage alongside the existing `pagesUpdated`/`pagesUnchanged`.

### Task 4 — Novelty/churn judgment operates on facts
- 4.26's novelty decision (`hasNewFacts`) now compares **extracted facts vs the current page** (clean vs clean), not anchor overlap and not raw vs page. `hasNewFacts: true` only when an extracted fact is not already stated on the page. Churn guard (skip cosmetic-only) stays.

### Task 5 — Tests (acceptance = read the page, confirm clean integration)
- **The acceptance test:** `curate memory-system --refresh` over a fixture where the matched raw sessions contain (a) the fact "Phase 3 retrieval shipped" and (b) a large unrelated UX prompt → the page **gains "Phase 3 … shipped" / dashboard / 4.x facts**, the Phase-status line flips from "planned" to "shipped", `updated` advances, and **the UX prompt does NOT appear** anywhere in the page. Assert on page *content*, not section count.
- Extraction: a session with no entity facts → `[]`; a session with facts → concise list, no transcript verbatim.
- Churn: re-running refresh with no new facts → `pagesUnchanged`, no `.history` write.
- 30-pass drain: hot entity accumulates real facts cleanly, stays coherent, no raw dumps, no bloat.

### Task 6 — Docs
- `docs/MEMORY-FORT-SPEC.md`: consolidation is two-stage (extract facts → integrate); raw never reaches the page.
- `docs/ROADMAP.md`: Phase 4.27 shipped (completes 4.26).

You will **not**:
- Feed raw transcript text to a page rewrite (the whole point).
- Append raw observations to any page (remove the `## Refresh observations` dump).
- Re-extract the same session every pass (cache).
- Break the 4.25 no-append invariant or the `.history` archive / fact-coverage guard.

If per-session extraction makes a full drain too slow/expensive (one extraction call per relevant session × entity), **stop and ask** — a mitigation is to extract once per session into a persisted `facts` sidecar reused across all entities/passes, so extraction is amortized. But raw text must never reach the integrate step.

---

## Acceptance contract
1. `curate memory-system --refresh` produces a page that **contains the real recent facts** (Phase 3 shipped, dashboard, 4.x) and **does not contain** the unrelated UX prompt — verified by reading the page.
2. A tangential session (entity name-dropped only) contributes no content.
3. Re-running with no new facts → unchanged, no churn.
4. 30-pass drain: clean coherent pages that actually absorb new facts; no raw dumps, no bloat.
5. Full suite + typecheck + build clean.

---

## Commit boundaries
- Task 1: `feat: extractEntityFacts — per-session entity fact extraction (Phase 4.27 Task 1)`
- Task 2: `feat: knowledge-page integration consumes extracted facts, not transcripts; drop raw-dump refresh (Phase 4.27 Task 2)`
- Task 3: `feat: relevance pre-filter + extraction caching + cost reporting (Phase 4.27 Task 3)`
- Task 4: `feat: novelty judgment over extracted facts (Phase 4.27 Task 4)`
- Task 5-6: `test+docs: two-stage extract-then-integrate consolidation (Phase 4.27)`
