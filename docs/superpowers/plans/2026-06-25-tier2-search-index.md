# Tier-2 Search Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (or, in this project, the Codex-implements / Claude-audits loop) to implement task-by-task. Steps use checkbox (`- [ ]`) syntax. **Every phase ships and is gated by a packaged-app smoke (server in the child utility process + `/api/health` real report, by output not memory).**

**Goal:** Replace the dashboard's in-process full-corpus loads with a derived, incremental, on-disk SQLite index (FTS5 + vectors) hosted in the existing utilityProcess, so search/graph/health are bounded by result-K and batch size — not vault size — and the 8 GB heap stopgap can be retired.

**Architecture:** Markdown (`raw/`, `wiki/`) stays canonical and Obsidian-readable. A **derived, rebuildable** SQLite DB under the app data dir (NOT inside the synced vault) holds a file/chunk catalog, FTS5 lexical index, vectors, graph edges, and job state. An incremental reconciler keeps it current by **content hash** (mtime as a fast pre-filter). Search = BM25 (FTS5) ⊕ vector, fused by **RRF**, optional CPU rerank, cursor-paginated. Runs in the `dashboard-service` utilityProcess (Phase 2, shipped v0.10.14).

**Tech Stack:** TypeScript, **better-sqlite3** (bundles SQLite **with FTS5**; `node:sqlite` ships *without* FTS5 — verified 2026-06-25, Node 22+ has no `SQLITE_ENABLE_FTS5`, the `--sqlite-enable-fts5` configure flag is Node 23.x-only), a vector extension behind an adapter (**sqlite-vec** — MIT/Apache, license-clean, exact-first; sqlite-vector rejected on license+platform), the SQLite handle in a **worker_thread** owned by the `dashboard-service` utilityProcess (sync better-sqlite3 must not block the HTTP event loop), tsdown (self-contained bundles), electron-builder + `@electron/rebuild` (native module rebuild per Electron ABI).

> **Audit note (2026-06-25, GPT-5.5 trajectory review + independent verification):** Electron 35 is **EOL** (since 2025-09-02) → **Phase 0 upgrades it first**. `node:sqlite`-instead-of-better-sqlite3 was proposed and **rejected** (no FTS5 in Node 22). sqlite-vector **rejected**: Elastic License 2.0 (incompatible with our GPL-3.0-only) + no win-arm64 prebuilt. Exact vector search is **not** result-K-bounded (compute ∝ vectors×dim) — only its JS output is. Native packaging + the packaged-app capability matrix move to **Phase 0**, before any feature code.

---

## Research synthesis (grounded — decisions locked)

| Decision | Choice | Why / source |
|---|---|---|
| Store | better-sqlite3 (sync, FTS5 built-in) | `node:sqlite` lacks FTS5 ([Node docs](https://nodejs.org/api/sqlite.html)); FTS5 gives BM25 on-disk ([SQLite FTS5](https://www.sqlite.org/fts5.html)) |
| Vectors | adapter; **sqlite-vec** (MIT/Apache, license-clean) default; **exact** baseline before ANN; **graceful-degrade to lexical** if the ext won't load (vectors = acceleration, not a hard dep). **sqlite-vector REJECTED**: Elastic License 2.0 (incompatible with our GPL-3.0-only) + no win-arm64 prebuilt (v1.0.0, verified 2026-06-25) | [sqlite-vec](https://github.com/asg017/sqlite-vec); sqlite-vector license/platform per [repo](https://github.com/sqliteai/sqlite-vector) |
| Fusion | **RRF (rank-based)**, not weighted score averaging; tune `k`; deterministic tie-break; **parent-level dedup** so one long doc can't dominate top-K. **No cross-encoder in the first hybrid release** — add only if RRF fails a fixed relevance eval | weighted fails: BM25 unbounded vs cosine [-1,1] ([Digital Applied](https://www.digitalapplied.com/blog/hybrid-search-bm25-vector-reranking-reference-2026), [AppScale](https://appscale.blog/en/blog/hybrid-search-and-reranking-production-rag-bm25-dense-cross-encoder-2026)) |
| Chunking | structure-aware first: **native semantic records** (raw=observation, wiki=heading-section), recursive token split only when a record is oversized; **parent-child retrieval** (index child, return parent+neighbors); overlap **only** where a relevance test shows boundary failures (not a blanket 10–20%) | [Firecrawl](https://www.firecrawl.dev/blog/best-chunking-strategies-rag), [ByteTools](https://bytetools.io/guides/rag-chunking-strategies) |
| Change detection | **content hash (SHA-256) primary**, mtime+size fast pre-filter; tombstone **only after a verified-complete scan** (never on a missing root / permission error / interrupted walk); periodic full re-hash for same-size edits | hash reliable; mtime unreliable (git/sync), misses content-preserving edits ([incremental indexing](https://medium.com/@vasanthancomrads/incremental-indexing-strategies-for-large-rag-systems-e3e5a9e2ced7)) |
| Generation switch | stage a new generation, then **purge inactive rows from the live FTS table** (stale rows still skew bm25 corpus stats); full rebuild → new DB + integrity check + atomic pointer swap, never in-place | FTS5 bm25 reads whole-table term stats |
| Embeddings | lexical works **fully offline**; hosted (Voyage) embeddings are **opt-in**, UI states what leaves the machine, cost estimated before a backfill; reuse embeddings for unchanged record hashes; **embedding-profile fingerprint** (provider+model+dims+metric+input-mode+parser+chunker ver), not just `embeddingModel` | privacy/local-first; re-embed is the expensive op |
| Model drift | embedding-profile fingerprint; **backfill new profile alongside old, atomic switch** when complete | [index drift](https://tianpan.co/blog/2026-04-09-embedding-models-production-versioning-index-drift) |
| Location | app-data **local** dir (e.g. `LOCALAPPDATA`, NOT a cloud-backed roaming/`userData` path), NOT the vault; WAL mode | WAL must not run on a synced/network FS ([SQLite WAL](https://sqlite.org/wal.html)); Electron warns `userData` may be cloud-backed |
| Process | `dashboard-service` utilityProcess (Phase 2) hosts HTTP; **a single DB-owning worker_thread** inside it owns the one SQLite connection (one writer; request queue; search-priority over maintenance) | sync better-sqlite3 would block the HTTP loop; the utilityProcess is already the OOM/crash boundary ([utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)) |
| Prior art | Reor=LanceDB; obsidian-copilot=SQLite index; Khoj — all chunk-by-heading→embed→local store | [MotherDuck](https://motherduck.com/blog/obsidian-rag-duckdb-motherduck/) |

**Rejected:** libSQL native vector (slow indexing at 100k), DuckDB VSS (experimental, WAL recovery caveats), `node:sqlite` for FTS (no FTS5), per-query corpus load (current OOM), weighted-score fusion.

**Hard constraints:** markdown stays canonical/Obsidian-readable; single-user local; cross-platform unsigned installer (Win x64+arm64, macOS arm64, Linux x64) with **no end-user toolchain** (native module rebuilt in CI). The app already ships one native dep path (`sharp`) but NOT in the Electron bundle — **Phase 0** establishes shipping + rebuilding a native module + the vector extension for the utility process, on a **supported** Electron (35 is EOL).

**Index-as-cache principle:** the SQLite index is disposable acceleration. If it's missing, corrupt, incompatible, or rebuilding, search **degrades to the existing ripgrep/bounded path** over canonical markdown — never blocks access to the files.

---

## File structure

- Create `src/index/db.ts` — open/migrate the SQLite DB (better-sqlite3), WAL, app-data path, schema versioning.
- Create `src/index/schema.sql` (or inline migrations) — `files`, `chunks`, `chunks_fts`, `vectors`, `graph_nodes`, `graph_edges`, `jobs`, `meta`.
- Create `src/index/reconcile.ts` — walk vault, hash changed files, upsert/tombstone by generation.
- Create `src/index/chunk.ts` — markdown heading-aware + recursive chunker (256–512 tok, overlap).
- Create `src/index/db-worker.ts` — the worker_thread that owns the single SQLite connection; message-port request queue (search-priority).
- Create `src/index/vectors/adapter.ts` + `vectors/sqlite-vec.ts` — load extension, upsert/query exact; adapter so it's swappable.
- Create `src/index/search.ts` — FTS5 BM25 + vector top-K → RRF → paginate (no rerank in v1).
- Create `src/index/graph.ts` — materialized edges from frontmatter relations + wikilinks.
- Modify `src/dashboard/server.ts` — `/api/search`, `/api/graph`, `/api/health` read the index (behind a flag, legacy fallback during cutover).
- Modify `src/dashboard/dashboard-service.ts` — spawn the DB worker_thread, run the reconciler on a timer (via the worker).
- Modify `tsdown.config.js` / `electron-builder.yml` — native module + extension shipping (established in **Phase 0**); keep entries self-contained.
- Tests under `test/index/**` + `test/build/**` (native-packaging guard) + per-phase packaged-app smoke.

---

## Phased roadmap (reordered per the 2026-06-25 audit; each phase ships + is smoke-gated; later phases get their own detailed plan when reached)

- **Phase 0 — Electron upgrade + packaged native-capability matrix.** *(NEW — the de-risk gate; chosen "upgrade first".)*
  - **0a:** upgrade Electron 35 (EOL) → a supported line (41/42); re-verify the **existing** packaged app green — server in the utilityProcess, 4-target installers build, smoke passes. Ship as its baseline.
  - **0b:** a throwaway **"hello-index" spike** inside the real packaged utilityProcess on **all four targets** (Win x64, **Win arm64**, macOS arm64, Linux x64): open SQLite (better-sqlite3, rebuilt via `@electron/rebuild` against the new ABI) → create+query an FTS5 table → WAL, close, reopen → load the **sqlite-vec** extension → insert+query one vector → kill+restart the utilityProcess and confirm recovery. **Win arm64 + the vector ext is the gate.** If a target fails, that target's plan changes before any feature code. Extend the `test/build` guard to native `.node`/extension files.
- **Phase 3 — Catalog + FTS5 + reconciler (lexical), DB in a worker_thread.** Detailed below. Index-backed lexical search behind a flag, **shadow mode** (legacy still serves; compare quality/freshness). *Acceptance:* on the real 754 MB vault, index lexical search returns correct top-K vs legacy on a fixed query set; the **DB-worker** heap stays bounded vs indexed-row count (assert via `v8.getHeapStatistics` slope on a low old-space cap).
- **Phase 4 — Lexical cutover (the safety milestone — no vectors).** `/api/search` → the index; **DELETE the in-process BM25 corpus cache** `[DROP the full-corpus search path]`; ripgrep/bounded fallback when the index is absent/corrupt/rebuilding. This removes the last unbounded heap path and **does not wait for embeddings**.
- **Phase 5 — Vectors + RRF hybrid.** sqlite-vec **exact** top-K behind the adapter → **RRF** fusion (parent-dedup, deterministic tie-break) → cursor pagination (cursor carries query fingerprint + active generation). Graceful-degrade to lexical if the ext is missing. **No cross-encoder yet.** Measure recall vs legacy; only then consider quantization/ANN.
- **Phase 6 — Graph + health from the index.** Materialized neighborhoods/LOD; `/api/graph` + graph-health read the index; surface index freshness/last-good-scan/queue-depth/corruption in health.
- **Phase 7 — Incremental auto-heal/auto-promote + retire stopgap.** Convert each scheduler to changed-rows-only **separately** (define its invalidation deps first — global dedup/backlinks aren't automatically "changed-row" safe), retiring each 8 GB flag as its path becomes bounded; confirm a CI run at a low old-space cap.

---

## Phase 3 — detailed tasks

**Architecture:** the DB-owning **worker_thread** opens a WAL SQLite DB in the local app-data dir; a reconciler walks `raw/`+`wiki/`, detects changes by size+mtime pre-filter then SHA-256, chunks changed files, writes chunk rows + an FTS5 row per chunk in one transaction per file under a new `generation`, then **purges the prior generation's rows from the live FTS table** on activation (stale rows skew bm25). Lexical search = FTS5 BM25 over `chunks_fts`, bounded top-K, returning parent context. No vectors yet. **Prereq: Phase 0 already proved better-sqlite3 loads + FTS5 works in the packaged app on all four targets** — so Phase 3 is pure logic on a proven native base.

> Note: better-sqlite3 + `@electron/rebuild` are added and ABI-proven in **Phase 0**. Phase 3 assumes `import Database from "better-sqlite3"` works in vitest and packaged; if it doesn't, that's a Phase-0 regression — fix there, don't stub it away.

### Task 1: DB open + schema + migration

**Files:**
- Create: `src/index/db.ts`
- Create: `src/index/migrations/001_init.sql`
- Test: `test/index/db.test.ts`

- [ ] **Step 1 — failing test:** opening a DB in a temp dir creates the schema and reports `schemaVersion`.
```ts
import { openIndexDb } from "../../src/index/db.js";
it("opens a WAL db and applies the initial schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "idx-"));
  const db = openIndexDb(join(dir, "index.db"));
  expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r:any)=>r.name);
  expect(tables).toEqual(expect.arrayContaining(["files","chunks","chunks_fts","jobs","meta"]));
  expect(db.prepare("select value from meta where key='schemaVersion'").get()).toMatchObject({ value: "1" });
  db.close();
});
```
- [ ] **Step 2 — run, expect FAIL** (`openIndexDb` undefined). `npx vitest run test/index/db.test.ts`
- [ ] **Step 3 — implement** `openIndexDb(path)`: `new Database(path)`, `pragma('journal_mode = WAL')`, `pragma('foreign_keys = ON')`, run `migrations/001_init.sql` if `meta.schemaVersion` absent, set it to `1`. Schema (001_init.sql): `files(relPath PK, kind, sizeBytes, mtimeMs, contentHash, generation, errorState)`; `chunks(chunkId PK, relPath, observationId, ordinal, headingPath, byteStart, byteEnd, text, textHash, generation)`; `chunks_fts` = `CREATE VIRTUAL TABLE chunks_fts USING fts5(text, headingPath, relPath UNINDEXED, content='chunks', content_rowid='rowid')`; `jobs(id PK, kind, state, singleFlightKey, leaseExpiry, attempts, progress)`; `meta(key PK, value)`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `feat(index): open WAL sqlite index + initial schema`.

### Task 2: heading-aware + recursive chunker

**Files:** Create `src/index/chunk.ts`; Test `test/index/chunk.test.ts`.

- [ ] **Step 1 — failing test:** a markdown doc with two `##` headings yields chunks tagged with their `headingPath`, each ≤ the token cap, with overlap between adjacent same-section chunks.
```ts
import { chunkMarkdown } from "../../src/index/chunk.js";
it("splits by heading then by token budget with overlap", () => {
  const md = "# Title\n\n## A\n" + "alpha ".repeat(400) + "\n\n## B\nbeta gamma";
  const chunks = chunkMarkdown(md, { maxTokens: 256, overlapTokens: 32 });
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.every(c => c.tokenCount <= 256)).toBe(true);
  expect(chunks.find(c => c.text.includes("beta"))?.headingPath).toBe("Title > B");
});
```
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** `chunkMarkdown(md, {maxTokens=384, overlapTokens=48})`: split on ATX headings into sections (track `headingPath`); within a section, recursively split on paragraph→sentence boundaries to ≤ maxTokens; add `overlapTokens` carry-over between adjacent chunks of the same section. Token count = a cheap whitespace/heuristic estimator (document it; exact tokenizer not required for chunk-boundary purposes).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `feat(index): heading-aware recursive markdown chunker`.

### Task 3: reconciler (hash-based incremental upsert + tombstone)

**Files:** Create `src/index/reconcile.ts`; Test `test/index/reconcile.test.ts`.

- [ ] **Step 1 — failing test (full + incremental + delete):**
```ts
import { reconcileIndex } from "../../src/index/reconcile.js";
it("indexes changed files only and tombstones deleted ones", async () => {
  const vault = await mkdtemp(join(tmpdir(),"vault-"));
  await mkdir(join(vault,"raw","2026-06-01"),{recursive:true});
  await writeFile(join(vault,"raw","2026-06-01","s.md"), "## H\nhello world");
  const db = openIndexDb(join(vault,".index.db")); // test path; real path is app-data
  const r1 = await reconcileIndex(db, vault);
  expect(r1.filesIndexed).toBe(1);
  const r2 = await reconcileIndex(db, vault);          // unchanged
  expect(r2.filesIndexed).toBe(0);                      // hash match → skip
  await writeFile(join(vault,"raw","2026-06-01","s.md"), "## H\nhello changed");
  const r3 = await reconcileIndex(db, vault);
  expect(r3.filesIndexed).toBe(1);                      // content changed → re-index
  await rm(join(vault,"raw","2026-06-01","s.md"));
  const r4 = await reconcileIndex(db, vault);
  expect(r4.filesTombstoned).toBe(1);
  expect(db.prepare("select count(*) c from chunks").get()).toMatchObject({ c: 0 });
});
```
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** `reconcileIndex(db, vaultRoot)`: a new `generation = max+1`; walk `raw/`+`wiki/` `.md`; for each, compare size+mtime to `files` row (fast skip), else SHA-256 the content; if new/changed → `chunkMarkdown` → in ONE transaction replace that file's `chunks` + `chunks_fts` rows and upsert `files` (new hash, generation); mark every seen file with the generation; after a COMPLETE walk, tombstone (delete chunks + files rows) for files whose generation is stale. Bound work: stream-read files; cap bytes/transaction. Return `{filesIndexed, filesTombstoned, chunks}`.
- [ ] **Step 4 — run, expect PASS** (asserts incremental skip + change + delete).
- [ ] **Step 5 — commit:** `feat(index): hash-based incremental reconciler`.

### Task 4: FTS5 BM25 lexical search (bounded top-K)

**Files:** Create `src/index/search.ts`; Test `test/index/search.test.ts`.

- [ ] **Step 1 — failing test:** after reconcile, a query returns the matching chunk ranked by bm25, bounded by `limit`, with no full-corpus read.
```ts
import { lexicalSearch } from "../../src/index/search.js";
it("returns bm25-ranked chunks bounded by limit", async () => {
  // ...reconcile a vault with chunks containing "kafka" and "postgres"...
  const hits = lexicalSearch(db, "kafka", { limit: 5 });
  expect(hits.length).toBeLessThanOrEqual(5);
  expect(hits[0].text).toContain("kafka");
  expect(hits[0]).toHaveProperty("relPath");
  expect(hits[0]).toHaveProperty("score");
});
```
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** `lexicalSearch(db, query, {limit=20})`: `SELECT c.relPath, c.headingPath, c.text, bm25(chunks_fts) AS score FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`. Escape/normalize the FTS query (quote bareword, handle empty). Return rows. Memory = O(limit), not corpus.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `feat(index): fts5 bm25 lexical search`.

### Task 5: wire the index into the service (reconcile on a timer) behind a flag

**Files:** Modify `src/dashboard/dashboard-service.ts`, `src/dashboard/server.ts`; Test `test/dashboard/index-search-route.test.ts`.

- [ ] **Step 1 — failing test:** with `MEMORY_INDEX_SEARCH=1`, `/api/search?q=...` returns index results (injected index), and does NOT call the legacy `loadSearchCorpus`.
```ts
it("serves /api/search from the index when the flag is on", async () => {
  const server = await createServer({ /* inject index + a spy loadSearchCorpus that throws */ , env: { MEMORY_INDEX_SEARCH: "1" } });
  const res = await fetch(server.url + "/api/search?q=kafka");
  expect(res.status).toBe(200);
  expect((await res.json()).results[0].text).toContain("kafka");
  // legacy corpus loader must NOT have been called
});
```
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** in `dashboard-service.ts`, open the index (app-data path) and run `reconcileIndex` on a debounced timer **inside the gate** (reuse the Tier-1 admission gate so reconcile yields to search). In `server.ts`, when `env.MEMORY_INDEX_SEARCH==="1"`, route `/api/search` to `lexicalSearch(index, q, {limit})` and cursor-paginate; else legacy. Keep the legacy path for cutover.
- [ ] **Step 4 — run, expect PASS;** also `npx tsc --noEmit`, `npx vitest run test/index test/dashboard`, `npm run build`.
- [ ] **Step 5 — commit:** `feat(dashboard): index-backed lexical /api/search behind MEMORY_INDEX_SEARCH`.

### Task 6 (gate): packaged-app + memory acceptance

- [ ] Build installer, install (app fully killed first), launch. With the flag on, confirm by **output**: `/api/search?q=...` returns results; the **DB-worker** heap stays bounded while searching the 754 MB vault (run a script that hits search repeatedly and logs `v8.getHeapStatistics().used_heap_size` from the worker via a debug endpoint or the dashboard-service.log) — must NOT climb toward corpus size. Confirm the reconciler populated the index (`chunks` count > 0). Record results in `docs/release-evidence/`.
- [ ] Native load is already proven in **Phase 0** — a failure here is a Phase-0 regression (ABI/packaging), not a new task.

---

## Self-review

- **Spec coverage:** Phase 0 (Electron upgrade + native matrix) gates everything; Phase 3 = catalog/FTS/reconciler (detailed below); Phase 4 = lexical cutover + corpus-cache deletion (the safety milestone); Phase 5 = vectors+RRF; Phase 6 = graph/health; Phase 7 = incremental schedulers + stopgap retirement. Phase 3 tasks cover DB, chunking, reconcile (incremental+delete), FTS search, service wiring, and the packaged gate.
- **Placeholders:** none — each task has test code, the implementation contract, exact commands, and acceptance. (Phase 0 + Phases 4–7 are roadmap-level here; each gets its own detailed task plan when reached, per the writing-plans multi-subsystem rule.)
- **Type consistency:** `openIndexDb`, `chunkMarkdown({maxTokens,overlapTokens})`, `reconcileIndex(db,vaultRoot)→{filesIndexed,filesTombstoned,chunks}`, `lexicalSearch(db,query,{limit})` used consistently. Schema column names (`relPath`, `contentHash`, `generation`, `chunkId`, `headingPath`) consistent.
- **Risks flagged:** native ABI/packaging + Win-arm64 vector ext (**Phase 0 is the real gate**, before feature code); exact-vector compute ∝ vectors×dim (measure in Phase 5, not assumed K-bounded); embedding cost/privacy (opt-in, profile fingerprint); WAL-on-synced-FS (local app-data only); FTS bm25 stale-generation skew (purge on switch).

## Execution handoff

This project's loop is **Codex implements task-by-task, Claude audits (read + run + mutation-test) + the packaged-app smoke gates each phase** — the established workflow, equivalent to subagent-driven-development with two-stage review.

**Order:** Phase 0 first (Electron upgrade as its own re-verified baseline, then the native-capability spike). Only once Win-arm64 + sqlite-vec load in the packaged app do we start Phase 3. Phases 0, 4, 5, 6, 7 each get their own detailed task plan when reached.
