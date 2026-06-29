# Phase 3 Task 0 D1 Packaged Concurrency Spike - 2026-06-29

## Scope

- Task: D1 concurrency decision before any `src/index/**` feature code.
- Packaged runtime: yes.
- worker_thread: excluded by plan because packaged Electron cannot resolve better-sqlite3 there (electron#43513); not spiked as a candidate.
- Controller: `scripts/spike-index-concurrency.mjs`.
- Temporary utilityProcess child: `src/dashboard/index-concurrency-spike.ts`.

## Synthetic Vault

- Root: `C:\Users\<user>\AppData\Local\Temp\memory-fort-phase3-spike-2026-06-29\synthetic-vault`
- Markdown files: 3001
- Total corpus bytes: 750.00 MiB (786432000)
- Pathological files: `wiki/pathological/pathological-150mb.md` 150.00 MiB
- Chunking during spike: 64.00 KiB chunks, 32 chunks per transaction, `setImmediate` yield between transactions.

## Packaged Run

- Executable: `<repo>\dist\electron-installer\win-unpacked\MemoryFort.exe`
- App path: `<repo>\dist\electron-installer\win-unpacked\resources\app`
- Electron: 42.5.0
- Node: 24.17.0
- Platform: win32 x64
- Commands:
  - `npm.cmd run build`
  - `npm.cmd run electron:rebuild`
  - `npx.cmd electron-builder build --win dir --x64 --publish never`
  - `<repo>\dist\electron-installer\win-unpacked\MemoryFort.exe (MEMORY_INDEX_SPIKE=1)`

## Thresholds

| Metric | Threshold |
| --- | ---: |
| /api/search p50 | <= 50 ms |
| /api/search p95 | <= 200 ms |
| /api/search p99 | <= 500 ms |
| /api/search max | <= 1000 ms |
| Reconcile-owner RSS | <= 1.50 GiB |
| Reconcile-owner used_heap | not corpus-proportional (25% ratio guard plus 512.00 MiB soft guard) |
| Cold full-index target | <= 10.00 min (hard <= 20.00 min) |

## Results

| Option | Ran | Pass | Search samples | p50 | p95 | p99 | max | RSS peak | used_heap peak | DB+WAL | Cold full-index |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B | yes | FAIL | 373 | 67.6 ms | 121.3 ms | 157.4 ms | 338.1 ms | 206.05 MiB | 36.86 MiB | 872.52 MiB | 35573.0 ms |
| A" | yes | PASS | 339 | 40.4 ms | 68.3 ms | 72.4 ms | 80.0 ms | 197.76 MiB | 36.42 MiB | 925.60 MiB | 22950.2 ms |

## Option B Detail

- Pass: no
- Issues: search p50 67.6ms > 50ms
- Files indexed: 3001
- Chunks indexed: 14400
- Transactions: 450
- Search latency: p50 67.6 ms, p95 121.3 ms, p99 157.4 ms, max 338.1 ms, errors 0
- Event-loop delay: p95 80.2 ms, p99 122.6 ms, max 341.3 ms
- Memory peak: rss 206.05 MiB, external 42.88 MiB, arrayBuffers 0 B, heapUsed 36.86 MiB, used_heap 36.86 MiB (4.91% of corpus bytes)
- DB bytes: db 861.53 MiB, wal 10.95 MiB, shm 32.00 KiB, total 872.52 MiB
- Cold full-index wall-time: 35573.0 ms

## Option A" Detail

- Pass: yes
- Issues: none
- Files indexed: 3001
- Chunks indexed: 14400
- Transactions: 450
- Search latency: p50 40.4 ms, p95 68.3 ms, p99 72.4 ms, max 80.0 ms, errors 0
- Event-loop delay: p95 83.2 ms, p99 148.5 ms, max 655.4 ms
- Memory peak: rss 197.76 MiB, external 43.57 MiB, arrayBuffers 0 B, heapUsed 36.42 MiB, used_heap 36.42 MiB (4.86% of corpus bytes)
- DB bytes: db 861.53 MiB, wal 63.94 MiB, shm 128.00 KiB, total 925.60 MiB
- Cold full-index wall-time: 22950.2 ms

## D1 Recommendation

GO with **Option A" (second utilityProcess writer with read-only service connection)**.

Rationale: Option B missed: search p50 67.6ms > 50ms. Option A" met the same thresholds by isolating the single WAL writer in a second utilityProcess.

## Stop Point

Stopped after Task 0. No Task 1 schema/search/reconcile feature code was added under `src/index/**`, and no version bump or release work was performed.
