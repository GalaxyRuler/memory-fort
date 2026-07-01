# Phase 3 Part B — real 754 MB+ vault confirmation (2026-07-01)

Supplementary to the 4-target installed gate (`docs/release-evidence/phase3-2026-06-30.md`, run 28458795099, all 4 targets green). This run is the **real production vault** on the local Windows box, not the synthetic generator — the genuine OOM-fix proof on real data.

## Setup

- Build: `npx electron-builder --win dir --x64 --publish never` from main `296b8b8`, unpacked to `dist/electron-installer/win-unpacked`.
- Launch: `MEMORY_ROOT=C:\Users\<user>\.memory`, `MEMORY_INDEX_SEARCH=1`.
- Corpus walked (`raw/` + `wiki/`, what `reconcileIndex` indexes): **838 MiB + 7.8 MiB ≈ 846 MiB**, 3922 markdown files. (Total vault dir is 1.6 GiB incl. `.git`, logs, archive — not walked.)
- Index DB path (OS app-data, keyed by `sha256(vaultRoot)`): `%APPDATA%\Memory Fort\indexes\<hash>\index.db` — confirms D3 (index never lands inside the synced vault).

## Result — cold full index

| Metric | Value |
| --- | ---: |
| Cold full-index wall time | **~1 min 37 s** (process start 10:30:34 → `lastCompleteReconcile` 10:32:11) |
| Threshold (target / hard) | ≤ 10 min / ≤ 20 min |
| Chunks indexed | 525,345 |
| Files skipped (oversized) | **11** — real production files: three 19–24 MiB and two 6.4–6.7 MiB long session-capture transcripts, correctly caught by the Task-6 oversized-file-skip fix (not synthetic — these are genuine large files that exist in the live vault) |
| Index DB on disk | 1423.54 MB (`index.db`), 0.16 MB (`-shm`), **0.00 MB (`-wal`)** — the post-reconcile `wal_checkpoint(TRUNCATE)` worked |

## Result — process memory (the OOM-fix proof)

| Process | Role | Peak WorkingSet during active indexing | Steady-state WorkingSet after ready | Steady-state Private |
| --- | --- | ---: | ---: | ---: |
| index-writer | reconcile owner (WAL writer) | **228.0 MB** | 92.9 MB | 141.6 MB |
| dashboard-service | search (read-only WAL) | 95.9 MB | 95.2 MB | 122.0 MB |
| main (Electron) | — | 102.9 MB | 103.0 MB | 35.8 MB |

Corpus is **846 MiB**; peak reconcile-owner memory was **228 MB (~27%)**, well under the 1.5 GB RSS threshold and nowhere near corpus-proportional — no climb toward the corpus size at any point. This is the real-data confirmation of the Phase-3 goal: search memory is O(top-K)/bounded, not O(corpus).

## Result — search correctness on real content

`/api/search` returned HTTP 200 for every query, including mid-reconcile (issued while `currentState=walking`, before `ready`). Sample queries against real project-history content returned schema-correct, on-topic hits (`path`/`title`/`snippet`/`score`/`source`/`provenance`, matching the existing legacy `SearchResult` shape) — e.g. a query about the project's own sqlite-vec integration correctly surfaced the raw capture discussing that work. Not reproduced verbatim here (real vault content).

## Verdict

Part B confirms Part A (the 4-target synthetic gate): **the OOM fix holds on the real vault** — cold full-index in ~1.5 minutes (well under threshold), memory bounded and non-corpus-proportional throughout, WAL checkpointed to zero after completion, and index search returns correct real results (including during an active background reconcile). `MEMORY_INDEX_SEARCH` remains OFF by default; this was a manual, isolated verification run. **Phase 3 fully confirmed on both synthetic and real data.**
