# Codex Implementation Brief — LLM-Judged Novelty (fix the hollow-drain skip) (Phase 4.26)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Fixes a flaw 4.25 introduced. Found by reading the actual page content (not just section counts): the drain "drained" the backlog but central pages never absorbed the content.

---

## What this is (verified live 2026-05-31)

4.25 made knowledge pages rewrite-only (good — no more append-bloat) but added a `skip: no new content` short-circuit that decides, via **fact-anchor overlap**, whether new observations are already covered. That heuristic is wrong, and it fails worst on the most important pages:

- `memory-system.md` — the central project — is **frozen at `updated: 2026-05-22`**. It describes "Phase 3 retrieval — *planned*" and "246 tests." The drain consumed ~1,240 raw files spanning 9 days of Phase-3/dashboard/4.x development; the page absorbed **none** of it.
- `agentmemory.md` — same, frozen at 2026-05-22.
- Thin pages (`iaqar`, `veritrace`) *did* update — because they had little existing content, so new observations didn't "overlap."

**Root cause:** anchor overlap ≠ semantic coverage. A new observation about memory-system shares anchors ("memory-system", "compile", "wiki") with the already-rich page, so it scores as "covered" and is skipped — even though it describes entirely new functionality. **The richer a page, the more aggressively it falsely skips new information.** Result: a hollow drain — watermark advances, central pages stop learning.

---

## The fix: semantic novelty judgment, with churn protection

Replace the anchor-overlap skip with an **LLM judgment**: for a knowledge page that has new observations this pass, hand the LLM the **current page body + the new observations** and have it return a structured decision:

```
{ "hasNewFacts": boolean, "body": string|null }
```

- `hasNewFacts: false` → skip (no write, no archive). The LLM judged the page already covers the observations.
- `hasNewFacts: true` → apply `body` (the updated page) via the existing 4.23/4.24 path: fact-coverage guard (stage if anchors lost) + `wiki/.history/` archive.

This makes "is this new?" a **semantic** question answered by the model that can actually read both texts — not a token-overlap proxy.

### Grounding (researched 2026-05-31)
- **Localized, judged updates beat blind full rewrites** — keep documentation current "without unnecessary full rewrites"; the model decides whether an update is needed.
- **LLM-as-judge for novelty** — judges can decide "genuinely new vs redundant" and should be right *for the right reasons*; make the prompt demand a substantive-fact justification, not vibes.
- **Structured/JSON decision** reduces ambiguity and churn.

Sources: [README maintenance with LLMs (arXiv 2603.00489)](https://arxiv.org/pdf/2603.00489), [Incremental summarization with structured representations (arXiv 2407.15021)](https://arxiv.org/html/2407.15021v1), [Exploring LLM-as-a-Judge (W&B)](https://wandb.ai/site/articles/exploring-llm-as-a-judge/).

---

## Scope guard

### Task 1 — Replace anchor-overlap skip with structured novelty judgment
- Remove the fact-anchor-overlap `skip: no new content` short-circuit for knowledge-page updates. Replace with the LLM structured call above (current page + new observations → `{hasNewFacts, body}`). The prompt MUST instruct: *only `hasNewFacts: true` if the observations contain substantive facts not already stated on the page; rewording, reformatting, or restating existing facts is NOT new. When true, return the full updated page integrating the new facts and preserving existing substantive content.*
- Apply path unchanged: fact-coverage guard + `.history` archive on apply; LLM-disabled → stage (never silently freeze).

### Task 2 — Churn protection (avoid the opposite failure)
- A too-eager "always update" makes pages thrash + `.history` bloat every pass. Guard against it:
  - Trust `hasNewFacts: false` → skip outright.
  - When `hasNewFacts: true`, before applying, compare the new body to the current page; if the diff is **cosmetic only** (normalized whitespace/wording, no added/removed substantive lines — reuse a normalized-line diff), treat as no-change and **skip** (the model over-claimed novelty).
  - One judgment call per knowledge-page-with-observations per pass — surface `pagesUpdated` / `pagesUnchanged` in the summary so churn is visible.

### Task 3 — Refresh the already-frozen pages
- The existing stale pages (`memory-system`, `agentmemory`, …) won't fix themselves — their observations are already past the watermark. Provide the path:
  - `memory curate <page> --refresh` (or extend `memory curate`) that **ignores the watermark** and re-feeds the page's source observations (raw files referencing it, within a window) through the novelty-judgment rewrite, so a frozen page can be brought current on demand.
  - Document that after 4.26, a one-time `memory curate --all --refresh` (or a `--reset-watermark` re-drain) is needed to backfill the 9 days the hollow drain skipped.

### Task 4 — Tests (acceptance = content freshness, not section count)
- **The test that I missed:** a page with rich existing content + observations containing a genuinely-new fact (e.g. "shipped Phase 3 retrieval") → `hasNewFacts: true`, page updated, the new fact present in the body, `updated` advances. THIS is the regression guard for the hollow drain.
- A page whose observations only restate existing content → `hasNewFacts: false`, skipped, no `.history` write.
- Cosmetic-only LLM "update" → skipped by the churn guard.
- 30-pass drain on a fixture hot entity that gains new facts over time → the page **accumulates the new facts** (content grows in substance) while staying coherent (no dated-section bloat). Assert on *content presence*, not just section count.

### Task 5 — Docs
- `docs/MEMORY-FORT-SPEC.md`: novelty is an LLM judgment, not anchor overlap; the hollow-drain failure mode and its guard.
- `docs/cli.md`: `memory curate --refresh`.
- `docs/ROADMAP.md`: Phase 4.26 shipped.

You will **not**:
- Re-introduce dated-section appends to knowledge pages (4.25 invariant holds).
- Apply a cosmetic-only rewrite (churn guard).
- Skip the `.history` archive or fact-coverage guard.
- Use token/anchor overlap as the novelty signal — that's the bug.

If the per-page judgment call makes drains too slow/expensive (one LLM call per page-with-observations per pass, vs the old cheap skip), **stop and ask** — a middle ground is a cheap embedding-similarity pre-filter to *order/batch* candidates, but the **decision** must remain the LLM's semantic judgment, never an overlap threshold.

---

## Acceptance contract
1. After a refresh drain, `memory-system.md` is **current** (`updated` ~today) and **contains the previously-missing facts** (Phase 3 retrieval shipped, dashboard, the 4.x arc) — verified by reading the page, not counting sections.
2. A page whose new observations are genuinely redundant is skipped (no churn, no archive).
3. Knowledge pages stay coherent and append-free (4.25 holds); `pagesUpdated`/`pagesUnchanged` reported.
4. `memory curate --refresh` brings a frozen page current.
5. Full suite + typecheck + build clean.

---

## Commit boundaries
- Task 1: `feat: LLM novelty judgment replaces anchor-overlap skip (Phase 4.26 Task 1)`
- Task 2: `feat: churn guard — skip cosmetic-only rewrites; report pagesUpdated/Unchanged (Phase 4.26 Task 2)`
- Task 3: `feat: memory curate --refresh re-feeds a frozen page's observations (Phase 4.26 Task 3)`
- Task 4-5: `test+docs: novelty judgment + hollow-drain regression (Phase 4.26)`
