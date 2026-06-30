# Codex handoff — Phase 3 Task 6: installed-app heap-bounded gate (THE Phase-3 gate)

> Self-contained brief. **Builds on merged Tasks 1–5** (DB+triggers, chunker, reconciler, search, A″ service wiring behind `MEMORY_INDEX_SEARCH=1`). This is the **final Phase-3 task** and the real payoff gate: prove the index makes search memory **O(top-K), not O(corpus)** in the **installed** app. After it passes, the **combined public release** (held since Phase 0) ships the native foundation + this feature. **Do not bump version / release in this task.**

## Goal

Prove, by output, in the **installed** desktop app with `MEMORY_INDEX_SEARCH=1`, that:
1. `/api/search` returns index-backed results (not the legacy corpus loader).
2. The reconcile-owner (the A″ second utilityProcess) and the search path keep **process memory bounded** while indexing + searching a **~750 MB vault** — within the Task 0 thresholds — i.e. the OOM is actually fixed.
3. Cold-start works: index builds in the background, first search doesn't block.

## Background (reuse, don't reinvent)

- **A″ architecture (Task 5, merged 280b2f9):** the dashboard-service holds a **read-only** WAL connection for search; a **second utilityProcess** (`src/dashboard/index-writer.ts`) owns the writable DB + runs `reconcileIndex` (debounced) + `wal_checkpoint(TRUNCATE)`. `electron/main.ts` forks the writer only when `MEMORY_INDEX_SEARCH=1`. `/api/index-status` reports state. Index DB at OS app-data `<appData>/Memory Fort/indexes/<sha256(vaultRoot)>/index.db`.
- **The benchmark harness already exists:** `scripts/spike-index-concurrency.mjs` (+ `src/dashboard/index-concurrency-spike.ts`) from Task 0 measures `/api/search` latency percentiles + `process.memoryUsage()` {rss,external,arrayBuffers,heapUsed} + `v8 used_heap_size` + event-loop delay + DB/WAL size + cold-index wall-time. **Reuse its measurement code** for Task 6 — point it at the REAL A″ path (the merged index-writer + read-only search) instead of the spike's crude inline impls, OR extract its sampling helpers.
- **Thresholds (Task 0, locked):** during an active full reconcile of a ~750 MB vault — `/api/search` p50 ≤ 50 ms, p95 ≤ 200 ms, p99 ≤ 500 ms, max ≤ 1000 ms; reconcile-owner RSS ≤ 1.5 GB and V8 used-heap NOT climbing toward corpus size; cold full-index ≤ 10 min (≤ 20 hard); DB+WAL recorded.

## What to build / run

### Part A — CI: installed-app probe on a synthetic ~750 MB vault (all 4 targets where feasible)
- Extend the installed CI lane (`.github/workflows/installed-native-probe.yml`, or a sibling) so that, on the installed/packaged app with `MEMORY_INDEX_SEARCH=1` pointed at a generated ~750 MB synthetic vault (reuse the spike's synthetic-vault generator incl. a pathological large file):
  1. the index-writer cold-indexes the vault → `chunks` count > 0; `/api/index-status` goes `building`→`ready`.
  2. `/api/search?q=…` returns index results (assert by output).
  3. while a reconcile runs, hammer `/api/search` and record the **Task 0 metrics** (latency percentiles + process memory of the reconcile-owner AND the service + event-loop delay + DB/WAL size + cold-index wall-time). Assert within thresholds; assert used-heap does NOT climb toward corpus size.
  4. assert the legacy `loadSearchCorpus` is never invoked in index mode (e.g. a log marker / absence).
- Targets: Win x64, **win-arm64**, macOS arm64, Linux x64 (the matrix already exists for the native probe). win-arm64 + macOS arm64 are load-bearing. A skipped target is a NO-GO.

### Part B — local: the REAL 754 MB vault (WHITEDRAGON, user-run)
- Claude/operator runs the **installed** app on the actual `~/.memory` vault (~754 MB) with `MEMORY_INDEX_SEARCH=1`: confirm `/api/search` returns sensible results; confirm the reconcile-owner process RSS/heap stays bounded (Task 0 thresholds) — the genuine OOM-fix proof on real data. Record in `docs/release-evidence/phase3-<date>.md`.

### Part C — golden-query drift harness
- A fixed query set over a vault snapshot: assert expected hits are present in BOTH the legacy path and the index path (NOT identical ranking) and that no legacy loader runs in index mode. This guards the eventual cutover (removing legacy + flipping the default) — which is a SEPARATE later task, not Task 6.

## Acceptance (THE GATE)
- Part A green on all four targets (esp. win-arm64 + macOS arm64): index search works + memory bounded within Task 0 thresholds + used-heap not corpus-proportional + legacy never called.
- Part B: real-vault run on WHITEDRAGON shows bounded memory + working search (recorded).
- Golden-query harness green.
- Evidence in `docs/release-evidence/phase3-<date>.md`.
- Native load already proven in Phase 0 — a native failure here is a Phase-0 regression.
- **Then** the combined public release is the next (separate) task; cutover (remove legacy + flip flag default) is after that.

## What NOT to do
- No version bump / release. No removing the legacy path or flipping `MEMORY_INDEX_SEARCH` default (that's the post-gate cutover task).
- Don't accept "unpacked artifact" as the gate (real installed artifacts) or measure only V8 heap (use process-level rss/external/arrayBuffers).
- Don't run the full vitest suite locally (server.test.ts is isolated in CI; run targeted).
- Keep `MEMORY_INDEX_SEARCH` default OFF.

## After Codex hands back — Claude's audit
1. Read the CI metric logs per target; confirm thresholds met + used-heap flat (not corpus-proportional) + legacy-never-called; win-arm64 + macOS arm64 present (no skips).
2. Run Part B on the real vault locally (Windows) — confirm bounded memory + working search.
3. Confirm the golden-query harness asserts expected hits in both paths.
4. On green: tick Task 6 → **Phase 3 feature complete** → hand off the combined public release (RELEASING.md + 4-target installed re-check), then the cutover task.

## References
- Plan: `docs/superpowers/plans/2026-06-28-tier2-phase3-lexical-index.md` (Task 6)
- A″ impl: `src/dashboard/index-writer.ts`, `src/dashboard/server.ts`, `electron/main.ts`
- Benchmark harness: `scripts/spike-index-concurrency.mjs`, `src/dashboard/index-concurrency-spike.ts`
- CI: `.github/workflows/installed-native-probe.yml`; release: `docs/RELEASING.md`
