# Codex Implementation Brief — Curate-Merge Consolidation (Phase 4.23)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Builds on 4.19–4.22. This is the architectural fork deferred in the 4.22 brief, now proven necessary.

---

## What this is (proven by a full drain, 2026-05-31)

Phase 4.22 made the index deterministic (✅ holds at scale) and made page updates *state-aware*. But a full 35-pass drain on the live vault showed the page model still fails for frequently-mentioned entities:

| page | 5 passes | 35 passes |
|---|---|---|
| `agentmemory.md` | 11 dated sections | **142** |
| `iaqar.md` | 1 | **41** |

The state-aware injection slowed per-pass appends but did **not** stop accumulation: hot entities recur in new raw bytes every pass, the model finds "something new," and appends another `## [date] update`. The result is an unreadable append-log, not a curated page. (The drain output was reverted; the vault is clean.)

The root is the **append-only model itself**. The fix is the one the Karpathy LLM-wiki pattern actually prescribes and 4.22's grounding already named: **curate-merge** — the model reads the current page + new observations and writes **one coherent article**, integrating new facts and dropping redundancy, instead of stacking dated sections.

---

## Grounding (researched 2026-05-31)

- **Update vs rewrite vs kill.** Not every change is an append; the model should choose to edit in place, rewrite/consolidate, or leave the page alone.
- **Content-preservation is the key risk.** Rewrites must be assessed for *content preservation, hallucination, and length change* — the failure mode is silently dropping facts. The mitigation is a **3-stage safeguard**: flag when an edit changes information, keep an **audit trail of all auto-generated content**, and allow post-hoc verification.
- **Curation = synthesize for relevance**, not accumulate.

Sources: [Update/Rewrite/Kill a page for LLMs (Medium)](https://medium.com/@yssxyss/keeping-your-content-fresh-for-llms-when-to-update-when-to-rewrite-when-to-kill-a-page-b96068f84e4c), [Executable & Verifiable Text-Editing with LLMs (arXiv 2309.15337)](https://arxiv.org/pdf/2309.15337), [RewriteLM (arXiv 2305.15685)](https://arxiv.org/html/2305.15685v2).

---

## Scope guard

### Task 1 — A `rewrite_page` operation (curate, don't append)
- Add a `rewrite_page` compile-op: `{ kind: "rewrite_page", path, body, frontmatter? }` where `body` is the **complete new page body** the model has curated from (existing page + new observations).
- Update `templates/prompts/compile.md`: for an entity that already has a page, the model should **prefer `rewrite_page`** — read the injected current page body ({{existing_pages}} from 4.22), integrate genuinely-new facts, preserve all substantive existing content, remove redundancy, and emit the coherent whole. Reserve `append_page`'s dated `## [date]` sections for genuinely time-stamped *events* (a decision made, a milestone), not routine knowledge updates. `write_page` stays for brand-new pages.

### Task 2 — Content-preservation guard (the load-bearing safety)
- Before applying a `rewrite_page`, compare the new body against the current page:
  - **Archive the prior version** under `wiki/.history/<path>/<timestamp>.md` (recoverable audit trail) — always, before any rewrite.
  - **Shrinkage guard:** if the rewrite drops the page below a threshold of the prior substantive content (e.g. new body < 60% of prior body's non-boilerplate length, or loses >N distinct prior `relations`/links), do **not** apply directly — **stage it to the inbox** with reason `"rewrite shrinks page — review for content loss"`.
  - High-confidence, non-shrinking rewrites apply directly; everything else stages.
- A `lint`/verify check `curation.content-loss` flags any canonical page whose latest rewrite shrank it past the threshold without operator review.

### Task 3 — Clean up existing bloated pages
- Add `memory curate <page> [--plan|--apply]`: feed the current (possibly 142-section) page to the LLM with a "consolidate this into one coherent article, lose no substantive facts" instruction, run it through the same content-preservation guard (archive + shrinkage stage), and write the result. This is how an already-bloated page gets fixed without a full re-drain.
- `memory curate --all [--plan]` to sweep every page over a section-count threshold.

### Task 4 — Tests
- `rewrite_page` integrates a new fact into an existing page → coherent body, prior facts preserved, prior version archived under `wiki/.history/`.
- Shrinkage guard: a rewrite that drops >40% of content → staged, not applied; archive written.
- `memory curate` on a fixture multi-section page → single coherent article, no fact loss, idempotent on re-run.
- Regression: a brand-new entity still uses `write_page`; a genuine time-stamped event still appends.
- Drain-quality test (the one that actually matters): simulate the hot-entity scenario (same entity across many passes) → page stays coherent (bounded sections), does **not** grow unboundedly.

### Task 5 — Docs
- `docs/MEMORY-FORT-SPEC.md`: document curate-merge, the `rewrite_page` op, the content-preservation guard + `wiki/.history/` archive, and `memory curate`.
- `docs/cli.md`: add `memory curate`.
- `docs/ROADMAP.md`: Phase 4.23 shipped.

You will **not**:
- Hard-delete or overwrite a page without archiving the prior version first (the audit trail is mandatory).
- Apply a shrinking rewrite directly — it always stages for review.
- Remove `append_page`/`write_page` — they remain for events and new pages; `rewrite_page` is the new default for *updates to existing knowledge pages*.
- Change the 4.19–4.22 watermark/fairness/index/caps behavior.

If judging "substantive content preserved" by length alone proves too crude (e.g. a legitimate dedup that genuinely shortens a bloated page trips the shrinkage guard), **stop and ask** — we may need a fact-coverage check (are the prior page's key entities/relations still present?) rather than a raw length ratio. Getting the guard right is the crux: too loose loses facts, too tight blocks the very consolidation we want.

---

## Acceptance contract
1. Re-running compile across many passes on a hot entity keeps its page **coherent and bounded** (no 142-section append-logs).
2. Every rewrite archives the prior version under `wiki/.history/`; shrinking rewrites stage for review.
3. `memory curate` collapses an existing bloated page into one coherent article with no substantive fact loss.
4. New pages and genuine events are unaffected. Full suite + typecheck + build clean.

---

## Commit boundaries
- Task 1: `feat: rewrite_page op + curate-not-append prompt (Phase 4.23 Task 1)`
- Task 2: `feat: content-preservation guard + wiki/.history archive (Phase 4.23 Task 2)`
- Task 3: `feat: memory curate consolidates bloated pages (Phase 4.23 Task 3)`
- Task 4-5: `test+docs: curate-merge consolidation (Phase 4.23)`
