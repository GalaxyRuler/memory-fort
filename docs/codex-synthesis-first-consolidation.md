# Codex Implementation Brief — Port agentmemory's Synthesis-First Consolidation (Phase 4.28)

**Target**: Codex 5.5
**Working directory**: `C:\CodexProjects\memory-system`
**Commit author**: `GalaxyRuler <aoa@live.ca>`
**Co-Authored-By**: `Claude Opus 4.8 <noreply@anthropic.com>`
**Branch**: current default (main). Stop and ask if scope creeps beyond this brief.

> This replaces the failed 4.26 (LLM-judged novelty — reverted) and 4.27 (two-stage late extraction — reverted, timed out at 13 min on one page). It ports the **proven** design from the predecessor `agentmemory`, verified against its real code on 2026-05-31. Keep 4.25's deterministic no-append invariant + `wiki/.history/` as the integration/lineage mechanism.

---

## Why (root cause, settled)

memory-system synthesizes **late**: it stores 190 MB of raw session transcripts and tries to distill them into pages at consolidation time. That's why every approach failed — append→bloat, skip→hollow, dump→pollution, extract→unbounded timeout. The fix is the one `agentmemory` already encodes: **synthesize EARLY into importance-scored facts, then consolidate from facts with hard bounds.**

## What agentmemory actually does (verified, with file:line)

**Stage A — Compress each observation once (`src/prompts/compression.ts`, `src/functions/compress.ts`):**
- Each observation → structured record: `{type, title, subtitle, facts[], narrative, concepts[], files[], importance}`.
- `importance` 1-10: *"1-3 routine reads, 4-6 edits/commands, 7-9 architectural decisions, 10 breaking changes"* (`compression.ts:26`). Input truncated to ~4 KB; secrets stripped.
- This happens **before** consolidation. Consolidation never sees raw transcripts.

**Stage B — Consolidate from compressed facts, bounded (`src/functions/consolidate.ts:104-194`):**
- Group compressed observations by `concept` (lowercased).
- Keep concepts with **≥3 observations** (`consolidate.ts:123`).
- Per concept, take the **top 8 by importance**: `.sort((a,b)=>b.importance-a.importance).slice(0,8)` (`130-131`).
- **Hard cap: `MAX_LLM_CALLS = 10` per run** (`119, 127`) + **30 s timeout per call** (`148`). ← the bounds memory-system lacked.
- Synthesize the top-8's `title/narrative/files/importance` (NOT raw) into ONE memory.
- **Versioned evolve, not append** (`161-191`): on title match, old → `isLatest=false`; new record gets `version+1`, `parentId`, `supersedes:[old,...]`, `sourceObservationIds`.

---

## The port (adapted to memory-system's file model)

memory-system raw = one markdown file per **session** (many tool events). So compress **per session** (not per event — that's 65k calls) into a handful of importance-scored facts, **once**, watermarked. Consolidation reads the pre-computed facts — no re-extraction (4.27's fatal mistake was re-extracting from raw every pass).

### Task 1 — Compression layer (Stage A): `memory compress`
- Add `compressSession(rawText, llm) → CompressedFact[]` where `CompressedFact = { title, facts: string[], narrative, concepts: string[], files: string[], importance: 1-10, sessionId, observedAt }`. Use agentmemory's compression prompt + importance scale verbatim (adapt for a whole session: "extract the salient facts; one fact-bundle per distinct topic/entity"). Truncate input, strip secrets (reuse existing redaction).
- Store facts in a new `~/.memory/facts/<date>/<session>.json` (or `.md` with frontmatter) — one file per session, parallel to `raw/`.
- **Watermark**: each raw session is compressed exactly once (reuse the 4.19 consumed-watermark pattern in `compile-state.json`, separate `compressed` map). `memory compress [--drain] [--max-sessions <n>]` processes uncompressed sessions in bounded batches; resumable.
- Cost is **one-time per session, amortized** (~1,300 calls for the existing backlog, bounded/resumable; ~per-session going forward). Each call is cheap (one session, ~4 KB, gpt-4o-mini).

### Task 2 — Consolidate from facts, with agentmemory's bounds (Stage B)
- Rewrite the knowledge-page consolidation path to read `CompressedFact`s (NOT raw, NOT live extraction):
  - Group facts by `concept` (≈ entity / wiki page); keep concepts with **≥3 facts**.
  - Per concept, **top 8 by importance**.
  - **`MAX_LLM_CALLS` cap per run (default 10)** + **30 s per-call timeout**.
  - Synthesize the top-8 fact bundles into the page via the **4.25 deterministic rewrite** (no-append invariant stays) — input is the clean facts, never raw.
- Filter low-importance facts (`< 4`) out of consolidation (noise floor).

### Task 3 — Versioned lineage (formalize `.history`)
- On rewrite, set page frontmatter `version: n+1`, `supersedes:` (prior version path/hash), keep the prior under `wiki/.history/` (already built). This is agentmemory's `version`/`parentId`/`supersedes`/`isLatest` adapted to files.

### Task 4 — Retire the dead-ends
- Remove/disable the 4.27 live two-stage extraction in the compile path and the 4.26 anchor-overlap/novelty-judgment-on-raw skip. Consolidation now operates only on pre-compressed facts. Keep `curate --refresh` but re-point it at the facts layer (no raw transcript ever enters a rewrite). Delete the `## Refresh observations` raw-dump for good.

### Task 5 — Decay / forget (port agentmemory's `auto-forget.ts`, lighter)
- Optional but recommended: a `facts` decay so low-importance, never-resurfaced facts age out; contradiction resolution (a new fact superseding an old one on the same concept). If this balloons scope, **stop and ask** and ship Tasks 1-4 first.

### Task 6 — Tests (acceptance = bounded + content, read the page)
- **Bounded:** a full `compress --drain` then `compile --execute --drain` completes in reasonable time with **no call exceeding the cap / no 13-minute hangs**; per-run LLM calls ≤ `MAX_LLM_CALLS`.
- **Content (the gate I kept missing):** after compress+consolidate, `memory-system.md` **contains the real recent facts** (Phase 3 retrieval shipped, dashboard, the 4.x arc — sourced from compressed facts of the relevant sessions) and **does NOT contain** raw transcript noise (the iAqar UX prompt). Assert on page content, read it.
- **Hot entity:** 186-session entity consolidates from its **top-8 importance facts**, not 186 calls.
- **Idempotent:** re-running compress on an already-compressed session = no-op; re-consolidating with no new facts = unchanged page, no `.history` write.

### Task 7 — Docs
- `docs/MEMORY-FORT-SPEC.md`: the two-stage **compress (early) → consolidate (bounded, top-K by importance)** pipeline; cite this as a port of agentmemory.
- `docs/cli.md`: `memory compress`.
- `docs/ROADMAP.md`: Phase 4.28 shipped; 4.26/4.27 retired.

You will **not**:
- Feed raw transcripts to any synthesis/rewrite step (compress first, always).
- Run unbounded consolidation (`MAX_LLM_CALLS` cap + ≥3 threshold + top-8 are mandatory).
- Break 4.25's no-append invariant or the `.history` archive.
- Re-extract facts from raw on every pass (compress once, watermarked).

If per-session compression of the 1,300-session backlog is too slow even batched, **stop and ask** — mitigation is to compress only sessions above a size/recency threshold first, or compress lazily (only sessions referencing a page being consolidated), but the invariant holds: consolidation reads pre-computed facts, never raw.

---

## Acceptance contract
1. Consolidation is **bounded** — no run exceeds `MAX_LLM_CALLS`; no multi-minute hangs; a hot entity uses its top-8 facts, not all its sessions.
2. `memory-system.md` ends up **current and correct** — contains the real recent facts, excludes raw noise — verified by reading it.
3. Pages evolve with `version`/`supersedes` + `.history`; no append-bloat; idempotent.
4. Compression is one-time per session (watermarked, resumable).
5. Full suite + typecheck + build clean.

---

## Commit boundaries
- Task 1: `feat: memory compress — per-session importance-scored fact extraction (Phase 4.28 Task 1)`
- Task 2: `feat: consolidate from facts, top-K by importance, MAX_LLM_CALLS bound (Phase 4.28 Task 2)`
- Task 3: `feat: versioned page lineage (version/supersedes) (Phase 4.28 Task 3)`
- Task 4: `refactor: retire 4.26/4.27 raw-transcript consolidation paths (Phase 4.28 Task 4)`
- Task 5: `feat: fact decay + contradiction resolution (Phase 4.28 Task 5)` *(optional)*
- Task 6-7: `test+docs: synthesis-first consolidation ported from agentmemory (Phase 4.28)`
