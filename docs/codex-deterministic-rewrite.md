# Codex Implementation Brief — Deterministic Knowledge-Page Rewrite (Phase 4.25)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Operator decision (2026-05-31): make bloat **structurally impossible**, not model-dependent. 4.22–4.24 relied on prompting/steering the LLM to choose `rewrite_page`; it kept appending (dated appends dodged every backstop — verified: `memory-system.md` hit 12 dated sections in a 30-pass drain, four sharing one date). This phase removes the model's ability to append to knowledge pages.

---

## The rule

**Knowledge pages are never appended — only rewritten.** For pages whose type is a *knowledge* type (`projects`, `lessons`, `decisions`, `references`, `tools`, `people`, `prospective`), any update to an **existing** page is applied as a **whole-page rewrite** that integrates the new content into a coherent article. The model's choice of `write_page`/`append_page` vs `rewrite_page` no longer matters — the executor enforces rewrite regardless.

**Event pages still append.** `threads` (and the root `log.md`) are chronological by nature — appends are correct there. New pages (target doesn't exist) still use `write_page`.

This makes the failure mode impossible: there is no code path that adds a dated `## [date] update` section to a knowledge page.

---

## Grounding (added retroactively 2026-05-31)

This is the established **"enforcement over instruction"** pattern for LLM systems — verified after the fact:
- The shift from *prompting the model to behave* to *constraining it in code* is the documented "harness → enforcement" progression: "rather than accepting outputs, systems verify and enforce them, constraining the model instead of assisting it."
- **Why structural beats prompting, quantified:** "a deterministic constraint is completely reliable (100% precision and recall)… a stochastic constraint is not completely reliable because it invokes a model." 4.22–4.24 were stochastic (prompt the model to rewrite); 4.25 is deterministic (no append path exists). That's exactly the reliability gap that broke them.

Sources: [From Harness to Enforcement — deterministic guardrails for LLM systems](https://bh3r1th.medium.com/from-harness-to-enforcement-designing-deterministic-guardrails-for-llm-systems-6a9912ba7eba), [Semantic Integrity Constraints — declarative guardrails (VLDB vol18 p4073)](https://www.vldb.org/pvldb/vol18/p4073-lee.pdf).

---

## Scope guard

### Task 1 — Page classification
- Add `isKnowledgePageType(type)` → true for `projects|lessons|decisions|references|tools|people|prospective`; false for `threads`. Source of truth: one helper, reused.

### Task 2 — Executor converts knowledge-page updates to a single rewrite
- `applyCompileOperations` gains access to the configured LLM provider (compile `--execute` already constructs one — thread it through; in `--plan` or no-LLM, fall back to staging, never append).
- **Group the pass's operations by target page.** For each **existing knowledge page** with one or more `write_page`/`append_page`/`rewrite_page` ops:
  - Collect the new content (op bodies/sections).
  - Make **one** rewrite LLM call: *"Here is the current page + this new content. Produce one coherent, deduplicated article that integrates the new facts and preserves all substantive existing content. Do not add dated update sections."*
  - Apply via the existing 4.23/4.24 rewrite path: **fact-coverage guard** (stage if anchors lost), **`wiki/.history/` archive** before write. One rewrite per page per pass (batched — not per op).
- A `write_page`/`append_page` to an existing knowledge page is therefore **never appended**; it is folded into the rewrite. If the LLM rewrite call fails or the guard trips, **stage to the inbox** (`compile-proposed/`) — never fall back to appending.

### Task 3 — Threads/events still append; new pages still create
- `threads` pages and `append_log` are unchanged (append is correct).
- New knowledge pages (target doesn't exist) use `write_page` as today.

### Task 4 — Cost is real; make it visible and bounded
- Each updated knowledge page = **one extra rewrite LLM call per pass**. Surface it: the compile summary reports `pagesRewritten` and (if available) the token/cost estimate. Over a drain this is the dominant cost — that's the deliberate tradeoff for structural correctness.
- Bound it: only rewrite a page if the new content is **not already covered** (reuse the 4.22/4.24 near-duplicate / fact check) — if the page already covers the observations, **skip** (`"skipped: no new content"`), no LLM call. This keeps drains from rewriting unchanged pages every pass.
- Respect `MEMORY_LLM_DISABLED` and the byte/context caps for the rewrite prompt (current page + new content must fit; if a page is itself huge, that's the curate path's problem — cap and note).

### Task 5 — Tests (the scale test is the acceptance gate)
- Unit: `write_page` and **dated** `append_page` to an existing knowledge page → both produce a **rewrite** (coherent body, no `## [date] update` section added), prior version archived. A `threads` append still appends.
- Unit: new-page `write_page` still creates; LLM-disabled → stages, never appends.
- Skip: new content already covered → no rewrite, no LLM call.
- **Scale test (acceptance gate):** simulate a hot knowledge entity across 30 passes (current prompt) → its page stays a **single coherent article**, dated-section count stays **0**, `.history` accumulates one archive per actual rewrite, and the page is never an append-log. This is the test that 4.22/4.24 passed at small N and failed at large N — it must pass at N=30.

### Task 6 — Docs
- `docs/MEMORY-FORT-SPEC.md`: knowledge pages are rewrite-only; threads append; the executor enforces it structurally (not via prompting).
- `docs/ROADMAP.md`: Phase 4.25 shipped.

You will **not**:
- Append a dated section to any knowledge page (the whole point).
- Fall back to appending when a rewrite fails — stage instead.
- Skip the `wiki/.history/` archive or the fact-coverage guard.
- Change threads/log append behavior, the watermark/fairness/caps, or the deterministic index.

If threading the LLM provider into `applyCompileOperations` is architecturally awkward (it currently does no LLM I/O), **stop and ask** — an alternative is a post-pass step in `runCompile` that, after the executor stages knowledge-page updates, performs the per-page rewrites. Either is fine; pick the cleaner one and note it. The invariant that matters: **no dated append ever lands on a knowledge page.**

---

## Acceptance contract
1. A 30-pass drain leaves every knowledge page a coherent article with **0** dated update sections; `.history` shows rewrites.
2. A dated `append_page` emitted by the model against an existing project page is converted to a rewrite, not appended.
3. Threads still append; new pages still create; LLM-disabled stages.
4. Drains skip pages whose new content is already covered (no wasted rewrite calls).
5. Full suite + typecheck + build clean.

---

## Commit boundaries
- Task 1: `feat: isKnowledgePageType classification (Phase 4.25 Task 1)`
- Task 2: `feat: executor folds knowledge-page updates into one rewrite per pass (Phase 4.25 Task 2)`
- Task 4: `feat: skip-if-covered + pagesRewritten cost reporting (Phase 4.25 Task 4)`
- Task 5-6: `test+docs: deterministic knowledge-page rewrite (Phase 4.25)`
