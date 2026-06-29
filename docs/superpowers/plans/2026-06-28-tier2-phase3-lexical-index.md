# Tier-2 Phase 3 — derived SQLite index + FTS5 lexical search (replaces full-corpus load)

> **Detailed, GPT-5.5-review-ready plan for Phase 3 of [the Tier-2 roadmap](2026-06-25-tier2-search-index.md).** Promotes the roadmap's Phase-3 task list into a standalone plan and surfaces the architecture decisions it left implicit. **This is the first `src/index/**` feature code.** Phase 0 (merged, main `35ce299`) proved the native stack (better-sqlite3 FTS5 + sqlite-vec) loads + runs in the **installed** app on all four targets — so Phase 3 is **pure logic on a proven native base**. **Codex implements (TDD); Claude audits.** Run this through the standing gate (plan → GPT-5.5 review → Claude verifies → revise → execute) before Task 1.

**Why this phase is the payoff:** today every dashboard search calls `loadSearchCorpus` (`src/retrieval/corpus.ts`) which loads the whole ~750 MB vault into the JS heap — the root cause of the desktop OOM ([[desktop-oom-large-vault]]). Phase 3 builds a **derived, incrementally-maintained SQLite index** (FTS5 BM25 over chunked markdown) so search memory is **O(top-K), not O(corpus)**. No vectors yet (Phase 5). Markdown stays canonical; the index is a throwaway derived artifact.

**Grounded prereqs (verified 2026-06-28):** better-sqlite3 12.11.1 (FTS5 + WAL, ABI-proven under Electron 42) + sqlite-vec vendored — all from Phase 0. Admission gate exists: `src/dashboard/full-corpus-admission.ts` (`defaultFullCorpusAdmissionGate.tryRunMaintenance(fn)`), already used by `auto-heal-scheduler` + `auto-promote-scheduler`. The dashboard backend runs in a utilityProcess (`src/dashboard/dashboard-service.ts`) anchored on `vaultRoot` (`MEMORY_ROOT` or `~/.memory`). Legacy search entry: `loadSearchCorpus({vaultRoot, scope})`.

**Out of scope (later phases):** vectors / sqlite-vec KNN + hybrid RRF (Phase 5); rerank/HyDE/Voyage (existing retrieval, untouched); removing the legacy corpus loader (kept for cutover until the index path is proven). No schema beyond what Tasks below specify.

---

## Key architecture decisions (RESOLVE in the GPT-5.5 review before Task 1)

These are the load-bearing choices the roadmap left implicit. Flagging them explicitly so the review can pressure-test them.

### D1 — Where does the DB live: nested `worker_thread` vs directly in the dashboard-service utilityProcess?
**The tension:** better-sqlite3 is **synchronous**. A full reconcile (hash + chunk + write thousands of rows) on the dashboard-service's HTTP event loop would **block `/api/search`** for the duration. The roadmap architecture says *"DB-owning worker_thread."* But Task 5 (roadmap) says *"in dashboard-service.ts, open the index" — that's in-process.*
- **Option A — nested worker_thread (roadmap's stated arch):** the utilityProcess spawns a `worker_thread` that owns the DB; HTTP handlers post query/reconcile messages and await replies. True isolation — a long reconcile never stalls search. Cost: a message protocol + serialization + a second runtime to manage; better-sqlite3 must load under the worker's ABI too (Phase 0 proved utilityProcess; a nested worker_thread under Electron is **one more ABI surface to prove** — add a capability check).
- **Option B — in-service, bounded + gated reconcile:** open the DB in the utilityProcess; run reconcile in **per-file transactions** via the admission gate (`tryRunMaintenance`) with a **bytes/rows-per-tick cap** that yields between files (`setImmediate`), so search interleaves. Simpler, one runtime, no new ABI surface. Risk: a single huge file's transaction still blocks briefly; search latency spikes during reconcile.
- **Recommendation to test in review:** **Option B first** (simpler, no new ABI surface, the gate already exists), with a measured search-latency-during-reconcile acceptance in Task 6; escalate to Option A only if B's latency is unacceptable. **GPT-5.5: challenge this — is per-file-txn yielding enough on a 750 MB vault, or is the worker_thread mandatory?**

### D2 — FTS5 external-content delete/sync correctness
`chunks_fts` is `content='chunks'` (external-content FTS5). With external content, **deleting/updating `chunks` rows does NOT auto-update the FTS index** — you must issue `INSERT INTO chunks_fts(chunks_fts, rowid, text, headingPath) VALUES('delete', old.rowid, old.text, old.headingPath)` before deleting, or use the documented triggers, or rebuild. The generation-purge + per-file re-index **must** handle this or bm25 silently returns stale/ghost rows. **The plan mandates the `'delete'` command (or triggers) + a test that proves no ghost rows survive a re-index/tombstone.**

### D3 — Index location + lifecycle
Index DB at **`<vaultRoot>/.index/index.db`** (derived, co-located, gitignored — add `.index/` to the vault `.gitignore`). Rationale: anchored to the same `vaultRoot` the service already has; portable; deletable to force a full rebuild. WAL sidecar files live alongside. (Alternative: OS app-data dir — rejected for portability/co-location, but GPT-5.5 may argue otherwise.) Schema migrations are forward-only (`meta.schemaVersion`); a bumped schema with no migration path → drop + rebuild (the index is derived, so rebuild is always safe).

---

## Tasks (TDD: failing test → run-fail → implement → run-pass → commit). Codex does one task per PR; Claude audits each.

### Task 1: DB open + schema + migration
**Files:** create `src/index/db.ts`, `src/index/migrations/001_init.sql`; test `test/index/db.test.ts`.
- Test: `openIndexDb(path)` → `journal_mode=wal`; tables `files, chunks, chunks_fts, jobs, meta` exist; `meta.schemaVersion='1'`.
- Implement: `new Database(path)`, `pragma('journal_mode = WAL')`, `pragma('foreign_keys = ON')`, apply `001_init.sql` when `meta.schemaVersion` absent, set `=1`. Schema: `files(relPath PK, kind, sizeBytes, mtimeMs, contentHash, generation, errorState)`; `chunks(chunkId PK, relPath, observationId, ordinal, headingPath, byteStart, byteEnd, text, textHash, generation)`; `chunks_fts USING fts5(text, headingPath, relPath UNINDEXED, content='chunks', content_rowid='rowid')`; `jobs(id PK, kind, state, singleFlightKey, leaseExpiry, attempts, progress)`; `meta(key PK, value)`. **Include the FTS5 external-content sync triggers (D2) in 001_init.sql** (insert/delete/update triggers keeping `chunks_fts` in sync), or document the explicit `'delete'`-command discipline the reconciler uses.
- Commit: `feat(index): open WAL sqlite index + initial schema`.

### Task 2: heading-aware recursive markdown chunker
**Files:** create `src/index/chunk.ts`; test `test/index/chunk.test.ts`.
- Test: a doc with two `##` headings → chunks tagged `headingPath` (`"Title > B"`), each `tokenCount ≤ maxTokens`, overlap between adjacent same-section chunks.
- Implement: `chunkMarkdown(md, {maxTokens=384, overlapTokens=48})` — split on ATX headings (track `headingPath`), recursively split sections on paragraph→sentence to ≤ maxTokens, add `overlapTokens` carry-over between adjacent same-section chunks. Token estimator = cheap whitespace heuristic (documented; exact tokenizer not needed for boundaries). Emit `byteStart/byteEnd` for parent-context retrieval.
- Commit: `feat(index): heading-aware recursive markdown chunker`.

### Task 3: reconciler (hash-based incremental upsert + tombstone)
**Files:** create `src/index/reconcile.ts`; test `test/index/reconcile.test.ts`.
- Test (full + incremental-skip + change + delete): index once (`filesIndexed=1`); re-run unchanged (`0`, hash-skip); change content (`1`); delete file (`filesTombstoned=1`, `chunks count=0` — **proves no ghost FTS rows, D2**).
- Implement: `reconcileIndex(db, vaultRoot)` — `generation = max+1`; walk `raw/`+`wiki/` `.md`; size+mtime fast-skip vs `files` row, else SHA-256; new/changed → `chunkMarkdown` → ONE transaction per file replacing that file's `chunks` + `chunks_fts` rows (via the D2 delete-then-insert discipline) + upsert `files`(hash, generation); mark seen files with the generation; after a COMPLETE walk, tombstone files with a stale generation (delete `chunks`+`files` rows + their FTS entries). Bound work: stream-read; cap bytes/rows per transaction (D1-B); yield between files. Return `{filesIndexed, filesTombstoned, chunks}`.
- Commit: `feat(index): hash-based incremental reconciler`.

### Task 4: FTS5 BM25 lexical search (bounded top-K)
**Files:** create `src/index/search.ts`; test `test/index/search.test.ts`.
- Test: after reconcile, query returns the matching chunk ranked by bm25, bounded by `limit`, with `relPath` + `score`; no full-corpus read.
- Implement: `lexicalSearch(db, query, {limit=20})` → `SELECT c.relPath, c.headingPath, c.text, bm25(chunks_fts) AS score FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`. Escape/normalize the FTS query (quote barewords, handle empty/operators-injection). Memory O(limit).
- Commit: `feat(index): fts5 bm25 lexical search`.

### Task 5: wire the index into the service behind a flag (reconcile on a timer)
**Files:** modify `src/dashboard/dashboard-service.ts`, `src/dashboard/server.ts`; test `test/dashboard/index-search-route.test.ts`.
- Test: with `MEMORY_INDEX_SEARCH=1`, `/api/search?q=...` returns index results (injected index) and does **NOT** call the legacy `loadSearchCorpus` (spy throws).
- Implement (per D1 decision): open the index at `<vaultRoot>/.index/index.db`; run `reconcileIndex` on a **debounced timer via `defaultFullCorpusAdmissionGate.tryRunMaintenance`** (so reconcile yields to search). In `server.ts`, when `MEMORY_INDEX_SEARCH==="1"` route `/api/search` → `lexicalSearch` (cursor-paginated); else legacy. **Keep the legacy path** for cutover. Flag default OFF.
- Verify: `tsc --noEmit` + `tsc -p tsconfig.ui.json --noEmit` + `vitest run test/index test/dashboard` + `npm run build`.
- Commit: `feat(dashboard): index-backed lexical /api/search behind MEMORY_INDEX_SEARCH`.

### Task 6 (THE gate): packaged-app + memory acceptance
**Files:** none (build + verify); evidence → `docs/release-evidence/phase3-<date>.md`.
- Build installer, kill app, install, launch with `MEMORY_INDEX_SEARCH=1`. Confirm **by output**: `/api/search?q=...` returns index results; the reconciler populated the index (`chunks` count > 0); **the DB-owner's heap stays bounded while searching the 754 MB vault** — hit search repeatedly, log `v8.getHeapStatistics().used_heap_size` (worker/service debug line) — must NOT climb toward corpus size (the OOM fix, proven by output). **Measure search latency during an active reconcile (D1 acceptance)** — if unacceptable under Option B, escalate to D1-A (worker_thread).
- Native load already proven in Phase 0 — a native failure here is a Phase-0 regression, not a new task.
- Commit/evidence; then the **combined public release** (held from Phase 0) ships the native foundation + this first feature, full `docs/RELEASING.md` + 4-target installed re-check.

---

## De-risking sequencing
1. Tasks 1→4 are pure logic, vitest-proven under system Node (better-sqlite3 ABI 137) — fast, no Electron. 2. Task 5 wires behind an OFF-by-default flag — zero user impact until flipped. 3. Task 6 proves the heap-bounding in the **installed** app (the actual OOM fix) + the reconcile-vs-search latency that decides D1. 4. Legacy `loadSearchCorpus` stays until Task 6 is green on real data — cutover (removing legacy + flipping the flag default) is a **separate** follow-up, not Phase 3.

## Self-review
- **Spec coverage:** schema (1) → chunking (2) → incremental reconcile (3) → search (4) → service wiring behind a flag (5) → installed heap-bounded acceptance (6). Each task: failing test → implement → pass → commit.
- **Risks flagged:** D1 (sync better-sqlite3 blocking the HTTP loop — worker_thread vs gated-in-service); D2 (FTS5 external-content ghost rows — mandated delete-discipline + a test); D3 (index path/lifecycle); 750 MB heap-bounding is the acceptance, not an afterthought. ABI is NOT re-litigated (Phase 0 owns it).
- **Placeholders:** none — every task has a concrete test + acceptance.

## Execution handoff
Codex implements **Task 1 → 6 in order, one PR per task** (TDD); Claude audits each (read diff + run vitest/typecheck + Task 6's installed heap check on Windows; CI covers the rest). **Hard gates:** (1) resolve D1/D2/D3 in the GPT-5.5 review before Task 1; (2) Task 5 flag stays OFF by default; (3) don't remove legacy corpus or flip the default until Task 6 is green on the real 754 MB vault. Roadmap: [Tier-2 search index](2026-06-25-tier2-search-index.md). Phase 0 (done): [phase 0 plan](2026-06-25-tier2-phase0-electron-native.md).
