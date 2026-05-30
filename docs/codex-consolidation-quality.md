# Codex Implementation Brief — Consolidation Quality: Deterministic Index + State-Aware Page Updates (Phase 4.22)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> Found by running a bounded 5-pass `compile --execute --drain` on the live vault (2026-05-31). The drain ran mechanically (no crash, watermarks advanced) but produced **low-quality output**. Two distinct bugs.

---

## Bug 1 — `update_index` blindly appends (no dedup, no section)

`applyOperation` `update_index` (`src/compile/execute.ts:508`):
```ts
case "update_index":
  await appendText(fullPath, `${operation.entries.map(e => e.trim()).filter(Boolean).join("\n")}\n`);
  return { ok: true, outcome: "index-updated" };
```
It appends entries to the **end** of `index.md` (which is under the last section, `## Tools`) with no dedup and no section placement. Live result after 5 passes: `iAqar` ×3, `agentmemory` ×3, `veritrace` ×2, all mis-filed under `## Tools` instead of `## Projects`. (The damage was uncommitted and has been reverted.)

## Bug 2 — pages accumulate redundant dated sections

The compile prompt injects `{{index_content}}` (the index **list**) but **never the existing page body**. So when the model updates `agentmemory.md`, it cannot see what's already there and just appends another `## [date] update`. Live result: `agentmemory.md` went **0 → 45 dated sections in 5 passes** because that entity is mentioned in nearly every raw file. The Phase-4.19 watermark stops re-reading the same *bytes*, but the same *entity* recurs in new bytes every pass, so the model re-emits a page update each time.

---

## Grounding (researched 2026-05-31)

This system explicitly follows Karpathy's LLM-curated-wiki pattern, and that pattern does **not** blind-append:
- **Insertion-time keep/edit/delete (ERASE).** When new content arrives, identify the related existing page and decide whether to keep, **edit**, or delete it — the KB should "represent the current state," not an append log.
- **Merge.** For duplicate/overlapping concepts, the LLM reads the existing page + the new content and **writes one clean article incorporating all substantive content**, rather than stacking sections.
- The enabling mechanism for both: **give the model the current page state** so it can do an incremental edit instead of a blind append.

Sources: [Karpathy LLM knowledge base architecture (MindStudio)](https://www.mindstudio.ai/blog/karpathy-llm-knowledge-base-architecture-compiler-analogy), [self-improving personal KB (L. Wang)](https://louiswang524.github.io/blog/llm-knowledge-base/), [ERASE — editable external knowledge](https://arxiv.org/pdf/2406.11830).

---

## Scope guard

### Task 1 — Deterministic index (fixes Bug 1 robustly)
- Stop trusting the model's `update_index` append. Add a deterministic `rebuildIndex(vaultRoot)` that regenerates `index.md` from the actual `wiki/` tree: group pages under the correct section by page **type** (Projects/Decisions/Lessons/References/Tools/Threads/Procedures/Prospective), **one entry per page** (dedup by path), sorted, description from each page's frontmatter `title`/first line. Exclude `.audit/`, `*-proposed/`, `archive/`.
- Call `rebuildIndex` at the end of a successful `--execute` (and expose `memory reindex [--plan]`). The `update_index` op kind becomes a no-op or is removed from the model contract (update the prompt so the model no longer emits it).
- Idempotent: running reindex twice produces byte-identical output.

### Task 2 — Inject existing page content + state-aware update instruction (reduces Bug 2)
- When assembling the compile prompt, for every wiki page that the candidate raw observations reference (or, simpler, every existing page within a size budget), inject the **current page body** into a new `{{existing_pages}}` context block, each clearly delimited with its path.
- Update `templates/prompts/compile.md`: instruct the model, ERASE-style — for an entity that already has a page, **decide keep/edit**: only emit an operation if there are genuinely new facts *not already on the page*, and prefer **editing the page's body in place** (or adding to the relevant existing section) over appending a new dated section. If the page already covers the observations, **emit nothing** for it.
- Respect the prompt size budget (Phase 4.20 + the files-per-pass bound): inject existing-page bodies within a byte cap; if over budget, inject the pages most-referenced by this pass's raw.

### Task 3 — Converter semantic-dedup backstop
- In `convertExistingWriteToAppend` / the append path, before writing a section, **skip it if its normalized content is already substantially present** in the target page (e.g. high token-overlap with an existing section). This is the safety net for when the model still over-emits. Record `outcome: "skipped: no new content"` (already exists) and extend it to near-duplicate, not just exact-duplicate.

### Task 4 — Tests
- `rebuildIndex`: a vault with pages across types → correct sections, one entry per page, no dups, idempotent on re-run.
- Prompt assembly: existing page bodies are injected under `{{existing_pages}}` within the byte budget.
- Converter: an append whose content is ~90% present in the page → skipped as no-new-content.
- Regression: a genuinely-new fact still produces an edit/append (don't over-suppress).

### Task 5 — Docs
- `docs/MEMORY-FORT-SPEC.md`: document deterministic index + state-aware (keep/edit) consolidation.
- `docs/cli.md`: add `memory reindex`.
- `docs/ROADMAP.md`: Phase 4.22 shipped.

You will **not**:
- Rewrite/merge whole pages destructively in this brief (full curate-merge is the bigger architectural step below — out of scope here). This brief makes updates *state-aware* (the model sees the page and self-suppresses redundancy) and the index *deterministic*; it does not rewrite existing page prose beyond the edit the model chooses.
- Change the watermark/fairness/caps from 4.19–4.21.
- Remove dated `## [date] update` sections as a mechanism — they're still right for genuinely time-stamped events; the fix is to stop emitting *redundant* ones.

**Decision flagged for the operator (do not implement without confirmation):** the deeper question is *append dated sections* vs *curate a single coherent page* (full ERASE/merge — the model rewrites the page incorporating new facts, archiving superseded content). The grounding favors curate-merge for a Karpathy-style wiki, but it's a larger change with content-loss risk. This brief does the safe 80% (state-aware updates + deterministic index). If the operator wants full curate-merge, that's a separate Phase 4.23.

---

## Acceptance contract
1. After any number of `compile --execute` passes, `index.md` has exactly one correctly-sectioned entry per page (no dups, no mis-filing).
2. Re-running compile on observations about an already-covered entity emits **no** new page operation (model sees the page, self-suppresses).
3. `agentmemory.md` does not accumulate near-duplicate dated sections across a multi-pass drain.
4. A genuinely-new fact still lands. Full suite + typecheck + build clean.

---

## Commit boundaries
- Task 1: `feat: deterministic index rebuild, dedup + section-aware (Phase 4.22 Task 1)`
- Task 2: `feat: inject existing page bodies + state-aware update prompt (Phase 4.22 Task 2)`
- Task 3: `fix: converter skips near-duplicate sections (Phase 4.22 Task 3)`
- Task 4-5: `test+docs: consolidation quality (Phase 4.22)`
