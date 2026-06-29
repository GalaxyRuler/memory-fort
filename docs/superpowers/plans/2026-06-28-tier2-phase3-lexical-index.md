# Tier-2 Phase 3 — derived SQLite index + FTS5 lexical search (replaces full-corpus load)

> **Detailed plan for Phase 3 of [the Tier-2 roadmap](2026-06-25-tier2-search-index.md).** First `src/index/**` feature code. Phase 0 (merged, main `35ce299`) proved the native stack loads in the **installed** app on all four targets — so Phase 3 is pure logic on a proven base. **Codex implements (TDD); Claude audits. Revised 2026-06-29 after a GPT-5.5 Pro review + primary-source verification** — see the audit note; the three architecture decisions are now **resolved**, not open.

**Why this phase is the payoff:** today every dashboard search runs `runSearch` (`src/retrieval/search.ts:248`) → `loadCorpusForSearch` → `loadSearchCorpus` (`src/retrieval/corpus.ts`), materializing the ~750 MB vault + BM25/token caches into the JS heap — the desktop-OOM root cause ([[desktop-oom-large-vault]]). Phase 3 builds a **derived, incrementally-maintained SQLite FTS5 index** so search memory is **O(top-K), not O(corpus)**. No vectors (Phase 5). Markdown stays canonical; the index is a throwaway derived artifact.

**Grounded (verified 2026-06-28/29):** better-sqlite3 12.11.1 (FTS5 + WAL, **synchronous**, ABI-proven under Electron 42 in the utilityProcess — *not yet in a nested worker_thread*). Admission gate `src/dashboard/full-corpus-admission.ts` (`defaultFullCorpusAdmissionGate.tryRunMaintenance`) only decides whether maintenance may **start**; it is **NOT preemptive** — it cannot interrupt a running synchronous better-sqlite3 transaction. Service anchors on `vaultRoot` (`MEMORY_ROOT`/`~/.memory`). `observationId` is unused in `src/` (dropped below).

**Out of scope:** vectors/KNN + hybrid RRF (Phase 5); rerank/HyDE/Voyage (untouched); removing the legacy corpus loader (kept behind the flag for cutover). 

---

> **AUDIT NOTE (2026-06-29, GPT-5.5 review + verification). All three load-bearing claims verified against SQLite/Node/better-sqlite3 primary docs — no drift. Resolutions:**
> - **D1 (concurrency):** better-sqlite3 is synchronous; the admission gate can't preempt it. "Per-file txn + setImmediate" is only as good as the worst single file (a 150 MB generated `.md` freezes `/api/search`). → **Add Task 0: a packaged concurrency/native spike** that (a) **proves better-sqlite3 + WAL + FTS5 inside a nested worker_thread under the utilityProcess** (Phase 0 proved the utilityProcess, NOT a nested worker — new ABI surface) and (b) measures Option B (in-service) vs a long-lived **DB-owner worker_thread with a priority queue** under a synthetic ~750 MB vault incl. a pathological huge file. **Bias: the worker-owner + search-preempts-reconcile is the likely mainline;** Option B only survives if the spike meets explicit latency/memory thresholds.
> - **D2 (FTS5 external-content):** verified — the user must keep `chunks_fts` in sync; the `'delete'` command needs the rowid **and the exact indexed column values** or "future query results [become] unreliable". → **Use the documented INSERT/DELETE/UPDATE triggers in `001_init.sql`** (not scattered manual deletes), plus `integrity-check` (rank=1 → `SQLITE_CORRUPT_VTAB` on mismatch) + `rebuild` as recovery. Explicit integer `rowid` on `chunks` (FTS `content_rowid='rowid'`).
> - **D3 (location):** verified — "WAL does not work over a network filesystem"; separating the DB from its `-wal`/`-shm` sidecars can lose transactions or **corrupt** the DB. The vault is an Obsidian/synced dir. → **Index in OS app-data, keyed by a hash of the vault root** (`<appData>/Memory Fort/indexes/<vaultRootHash>/index.db`), NOT inside the vault. Co-located `.index/` is a debug-only opt-in. Derived → corruption is recoverable by drop+rebuild (which must be rock-solid).

---

## Task 0 (NEW — de-risk D1 FIRST): packaged concurrency + nested-worker native spike

**Files:** `scripts/spike-index-concurrency.mjs` (+ a temporary capability check reusing the Phase-0 fork pattern); evidence → `docs/release-evidence/phase3-spike-<date>.md`. **No `src/index/**` yet — throwaway spike.**

- **Define thresholds up front** (this makes Task 6 a real gate): e.g. during an active reconcile of a ~750 MB synthetic vault, `/api/search` (or an equivalent ping) **p95 ≤ X ms, p99 ≤ Y ms, max ≤ Z ms**; DB-owner **RSS ≤ R**, V8 used-heap not climbing toward corpus size. Pick X/Y/Z/R with the user before running.
- **Prove the nested worker** in the **installed** app: from the dashboard utilityProcess, spawn a `worker_thread`, `import better-sqlite3`, open WAL, create an FTS5 (external-content) table, insert + MATCH, run an FTS `'delete'`/`rebuild`/`integrity-check` mini-cycle, shut down cleanly — on all four targets (CI matrix + local Windows). A nested-worker ABI failure here is the thing that picks Option A vs B.
- **Compare B vs worker-owner** under a synthetic vault (many small files **+ at least one pathological ~150 MB `.md`**): crude hash→chunk→insert while hammering search; record p50/p95/p99/max search latency, event-loop delay, `process.memoryUsage()` {rss, external, arrayBuffers, heapUsed}, `v8.getHeapStatistics().used_heap_size`, worker RSS, DB+WAL size. In the worker version, **prove interactive search preempts / interleaves reconcile slices** (not just "the same blocking loop moved into a worker").
- **Acceptance/decision:** record which option meets the thresholds. **GO into Task 1 only with D1 decided + the nested-worker proven (or Option B proven sufficient).** Commit: `spike(index): packaged concurrency + nested-worker probe (D1)`.

## Task 1: DB open + schema + migration (triggers, rowids, recovery, app-data path)
**Files:** create `src/index/db.ts`, `src/index/migrations/001_init.sql`; test `test/index/db.test.ts`.
- Test: `openIndexDb(path)` → `pragma('journal_mode',{simple:true})==='wal'`; tables `files, chunks, chunks_fts, meta` + the FTS triggers exist; `meta.schemaVersion='1'`; a deliberately-corrupted DB is detected → dropped (DB + `-wal` + `-shm`) → rebuilt.
- Implement `openIndexDb(path)`: default path = **OS app-data** `<appData>/Memory Fort/indexes/<sha256(vaultRoot)>/index.db` (debug override allowed); `new Database(path)`; `pragma('journal_mode = WAL')` **and assert it returned `wal`**; `pragma('foreign_keys = ON')`; bounded `pragma('busy_timeout = …')`; apply `001_init.sql` when `meta.schemaVersion` absent, set `=1`; forward-only migrations; **schema mismatch or `SQLITE_CORRUPT*` → close, delete DB+sidecars, rebuild** (safe: derived). Expose `integrityCheck()` (FTS `integrity-check` rank=1) + `rebuildFts()` helpers.
- **Schema (`001_init.sql`)** — explicit rowids, FKs, triggers, indexes:
  - `files(relPath TEXT PRIMARY KEY, kind TEXT, sizeBytes INTEGER, mtimeMs INTEGER, contentHash TEXT, generation INTEGER, lastSeenRunId INTEGER, errorState TEXT, indexedAt INTEGER, lastErrorAt INTEGER)`
  - `chunks(rowid INTEGER PRIMARY KEY, chunkId TEXT UNIQUE NOT NULL, relPath TEXT NOT NULL REFERENCES files(relPath) ON DELETE CASCADE, ordinal INTEGER NOT NULL, headingPath TEXT, byteStart INTEGER NOT NULL, byteEnd INTEGER NOT NULL, text TEXT NOT NULL, textHash TEXT NOT NULL, generation INTEGER NOT NULL)`
  - `chunks_fts USING fts5(text, headingPath, relPath UNINDEXED, content='chunks', content_rowid='rowid')`
  - **FTS sync triggers** (the verified pattern): `AFTER INSERT` → insert into `chunks_fts(rowid,text,headingPath,relPath)`; `AFTER DELETE` → `INSERT INTO chunks_fts(chunks_fts,rowid,text,headingPath,relPath) VALUES('delete',old.rowid,…)`; `AFTER UPDATE` → delete-then-insert.
  - `meta(key TEXT PRIMARY KEY, value TEXT)` (holds `schemaVersion`, `activeReconcileRunId`/`lastCompleteRunId`).
  - Indexes: `idx_chunks_relPath`, unique `idx_chunks_relPath_ordinal`, `idx_chunks_generation`, `idx_files_generation`, `idx_files_hash`.
  - **Dropped vs the roadmap:** the `jobs(singleFlightKey,leaseExpiry,…)` table (speculative — use in-memory singleflight + run metadata in `meta`/`files`); `chunks.observationId` (unused in `src/`).
- Commit: `feat(index): open WAL sqlite index + schema with fts triggers`.

## Task 2: heading-aware recursive chunker (UTF-8 offsets, huge-file safe)
**Files:** create `src/index/chunk.ts`; test `test/index/chunk.test.ts`.
- Test: two `##` headings → chunks tagged `headingPath` (`"Title > B"`), `tokenCount ≤ maxTokens`, overlap between adjacent same-section chunks; **`byteStart/byteEnd` are UTF-8 byte offsets** (verified by slicing a Buffer on non-ASCII content); a pathological huge section does not allocate unbounded memory; frontmatter/code-block/wikilink cases covered.
- Implement `chunkMarkdown(md, {maxTokens=384, overlapTokens=48, maxChunkChars})`: split on ATX headings (track `headingPath`), recursively split sections paragraph→sentence to ≤ maxTokens, **modest measured overlap** (note bm25 boundary-term bias — callers dedup/group by `(relPath, headingPath)`); cheap whitespace token heuristic (documented); **emit UTF-8 `byteStart/byteEnd`** (compute on a Buffer, not JS string indices); cap chunk + returned-context size; **huge-file policy** — stream/bounded read so one giant `.md` can't blow the heap (the acceptance is violated if reconcile allocates hundreds of MB for one file).
- Commit: `feat(index): heading-aware recursive markdown chunker`.

## Task 3: crash-safe reconciler (incremental upsert + complete-scan tombstone)
**Files:** create `src/index/reconcile.ts`; test `test/index/reconcile.test.ts`.
- Test (full + incremental-skip + change + delete + **crash-safety**): index once; re-run unchanged → 0 (size+mtime fast-skip, hash confirm); change → 1; delete → tombstoned, `chunks count=0` (**no ghost FTS rows** — also assert `integrity-check` passes); **kill mid-walk → reopen → old index intact, no spurious tombstones**; kill mid-file → that file's txn rolled back, old chunks remain. (Reuse the 0b.3c forced-kill technique for the crash tests.)
- Implement `reconcileIndex(db, vaultRoot)` with an explicit **run state machine**: start a `runId` (in `meta`); walk `raw/`+`wiki/` `.md`; size+mtime fast-skip vs `files`, else SHA-256; changed/new → `chunkMarkdown` → **one atomic transaction per file**: delete that file's `chunks` (triggers purge `chunks_fts`), insert new chunks, upsert `files`(hash, generation, `lastSeenRunId=runId`, `indexedAt`); unchanged → set `lastSeenRunId=runId` only. **Tombstone (delete chunks+files) ONLY for files whose `lastSeenRunId < runId` AFTER the walk completes AND the run is marked complete** — so a crash mid-walk runs no tombstone phase (old index stays conservative); each tombstone is its own atomic txn (rerun-safe). Bound work per D1 decision (per-file txn + yield, or worker slices); cap bytes/txn. Return `{filesIndexed, filesTombstoned, chunks}`.
- Commit: `feat(index): crash-safe incremental reconciler`.

## Task 4: FTS5 BM25 search (top-K CTE, sanitized query, bounded)
**Files:** create `src/index/search.ts`; test `test/index/search.test.ts`.
- Test: after reconcile, query returns the bm25-ranked chunk, `length ≤ limit`, with `relPath`+`score`; an FTS-operator-laden user string doesn't error/inject (treated as simple terms); empty-after-normalization → empty; a malformed MATCH is caught → empty/400, not 500; deterministic order on score ties.
- Implement `lexicalSearch(db, query, {limit=20})` — **top-K CTE** (find rowids+scores in `chunks_fts` first, `ORDER BY score ASC LIMIT ?`, then join `chunks` only for those K), clamp `limit`, deterministic tiebreaker (`score, rowid`). **Sanitize input as "simple search"**: tokenize, normalize Unicode, drop/escape FTS operators (`"` `*` `:` `NEAR` `AND/OR/NOT` columns), quote each term, intentional AND/OR; raw FTS syntax is a later explicit feature. Catch parser errors. Memory O(limit). bm25 lower=better (`ORDER BY score ASC`).
- Commit: `feat(index): fts5 bm25 lexical search`.

## Task 5: wire into the service behind `MEMORY_INDEX_SEARCH=1` (bypass legacy entirely)
**Files:** modify `src/dashboard/dashboard-service.ts`, `src/dashboard/server.ts`; test `test/dashboard/index-search-route.test.ts`.
- Test: with `MEMORY_INDEX_SEARCH=1`, `/api/search?q=…` returns index results and **`loadSearchCorpus` is never called** (spy throws) — index mode calls `lexicalSearch` **directly, not `runSearch`**.
- Implement (per D1): open the index (app-data path); own the DB per the D1 decision (worker or in-service); run `reconcileIndex` on a **debounced timer via `tryRunMaintenance`** (coarse "don't start during search" guard) **+** the D1 priority model (search ahead of reconcile slices). **Do not start reconcile inside the HTTP handler.** Route `/api/search` → `lexicalSearch` (cursor-paginated) when the flag is on, else legacy; **flag default OFF**. Add an index-status surface (DB path, schemaVersion, chunk count, last complete reconcile, current state, last error).
- Verify: both typechecks + `vitest run test/index test/dashboard` + `npm run build`.
- Commit: `feat(dashboard): index-backed lexical /api/search behind MEMORY_INDEX_SEARCH`.

## Task 6 (THE gate): installed-app + process-memory acceptance (with thresholds)
**Files:** none (build + verify); evidence → `docs/release-evidence/phase3-<date>.md`.
- Build installer, kill app, install, launch with `MEMORY_INDEX_SEARCH=1`. Confirm **by output**: `/api/search?q=…` returns index results; `chunks` count > 0; **the DB-owner's memory stays bounded** while repeatedly searching the real **754 MB** vault — log **`rss`, `external`, `arrayBuffers`, `heapUsed`, `v8 used_heap_size`, event-loop delay, worker RSS (if used), DB+WAL size, and `/api/search` p50/p95/p99/max during an active reconcile** — all within the **Task 0 thresholds**; none climbing toward corpus size. Prove `loadSearchCorpus` is not called in index mode.
- **Golden-query drift harness** (add in Task 5/6): a fixed query set over a vault snapshot — assert expected hits are present in both legacy and index paths (NOT identical ranking) and no legacy loader runs in index mode.
- Native load already proven in Phase 0 — a native failure here is a Phase-0 regression, not a new task.
- Then the **combined public release** (held from Phase 0) ships the native foundation + this first feature: full `docs/RELEASING.md` + 4-target installed re-check. **Cutover (remove legacy + flip the flag default) is a SEPARATE follow-up after Task 6 is green on real data.**

---

## De-risking sequencing
**Task 0 (packaged D1 spike) resolves the highest risk before any feature code.** Then 1→4 are pure logic (vitest, system Node) — fast, no Electron. Task 5 wires behind an OFF-by-default flag (zero user impact). Task 6 proves the heap-bounding + latency in the installed app on real data. Legacy stays until Task 6 green; cutover is separate.

## Self-review
- **Spec coverage:** concurrency/native spike (0) → schema+triggers+path+recovery (1) → UTF-8/huge-file-safe chunker (2) → crash-safe reconciler (3) → sanitized top-K search (4) → flagged wiring around legacy (5) → installed process-memory+latency gate (6).
- **Risks resolved (not just flagged):** D1 → Task 0 empirical decision + worker-bias; D2 → triggers + integrity-check/rebuild + rowid (verified); D3 → app-data not synced vault (verified WAL/network-FS); reconcile crash-safety → run-state machine + complete-scan-gated tombstone; huge-file heap → bounded chunker; FTS injection → simple-search sanitizer; memory proof → process-level + thresholds.
- **Placeholders:** none — each task has a concrete test + acceptance; ABI not re-litigated except the genuinely-new nested-worker surface (Task 0).

## Execution handoff
Codex implements **Task 0 → 6 in order, one PR per task** (TDD); Claude audits each (read diff + run vitest/typecheck + the installed/spike checks on Windows; CI covers the rest). **Hard gates:** (1) Task 0 must decide D1 + prove the nested worker before Task 1; (2) define the latency/memory thresholds with the user before Task 0 runs; (3) Task 5 flag OFF by default; (4) don't remove legacy / flip the default until Task 6 is green on the real 754 MB vault. Roadmap: [Tier-2 search index](2026-06-25-tier2-search-index.md). Phase 0 (done): [phase 0 plan](2026-06-25-tier2-phase0-electron-native.md).
