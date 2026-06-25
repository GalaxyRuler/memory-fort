# ADR 0001 — Out-of-main incremental SQLite index for dashboard search/graph (Tier-2)

- Status: **Proposed**
- Date: 2026-06-25
- Deciders: GalaxyRuler (+ AI pair)
- Supersedes: the v0.10.7–v0.10.11 in-process mitigations (heap stopgap removed, schedulers/verify isolated to child processes, graph byte-capped, full-corpus admission gate). Those bounded the *blast radius*; this ADR removes the *root invariant*.

## Context

The dashboard backend serves the UI on `127.0.0.1:4410`. As of v0.10.14 it runs in a long-lived Electron **utilityProcess** (Phase 2 of the migration below, already shipped); main only supervises/restarts it. Several features still materialize a corpus-proportional fraction of the vault into that process's JS heap on demand:

- `loadSearchCorpus({scope:"all"})` reads + parses **every** raw/wiki file into `SearchDocument` objects.
- `/api/search` (`runSearch`) loads the full corpus on first query (BM25 + embeddings + rerank) and caches it.
- Graph and `/api/health` verify previously did the same (now isolated/bounded).

On the affected machine the vault is **1.4 GB** (raw/ **754 MB** across **2787** files, avg 277 KB but with **20–30 MB** outliers; embeddings/ 134 MB), and the full-corpus load peaks **~3.3–3.5 GB**.

Two grounded facts make "give it more heap" a dead end:

- `v8.setFlagsFromString("--max-old-space-size")` after VM start "may simply do nothing" ([Node v8 docs](https://nodejs.org/api/v8.html)); Electron confirms `jsHeapSizeLimit` won't change after setting it ([electron#41248](https://github.com/electron/electron/issues/41248)).
- Pointer compression (Electron 14+) **hard-caps the main-process V8 heap at ~4 GB** regardless ([Electron V8 memory cage](https://www.electronjs.org/blog/v8-memory-cage), [electron#31330](https://github.com/electron/electron/issues/31330)). Electron's own guidance: **move memory-intensive work to a child process**.

So `/api/search` at ~3.5 GB sits right under the 4 GB cap. The Tier-1 admission gate stops it *overlapping* maintenance/verify, but a single `scope=all` search can still approach the ceiling, and the vault only grows. **The invariant to remove: "a normal request may materialize an unbounded fraction of the vault into the JS heap."**

Hard constraints (non-negotiable):

- Markdown + JSONL on disk stay human-readable and **Obsidian-compatible** (the vault is an Obsidian vault). A derived index *alongside* the files is fine; replacing the files is not.
- Single-user, local-only, privacy-sensitive (no cloud).
- Cross-platform installers (Windows x64+arm64, macOS arm64, Linux x64), unsigned, **no compiler toolchain on the end-user machine**.

## Decision

Build a **derived, incremental, on-disk index** and make search/graph/health query *it* (bounded by result-K and batch size, not by corpus size). Specifically:

1. **Store:** one SQLite database via **better-sqlite3** (synchronous, bundles SQLite **compiled with FTS5** — `node:sqlite` ships *without* FTS5, [Node sqlite docs](https://nodejs.org/api/sqlite.html)) holding: file/chunk catalog, FTS5 lexical index, graph nodes/edges, job/lease state, and vectors. Lexical ranking = FTS5 **BM25** ([SQLite FTS5](https://www.sqlite.org/fts5.html)).
2. **Vectors:** a SQLite vector extension behind an **adapter** so it can be swapped. Start with **exact** brute-force for a correctness baseline; evaluate ANN/quantization only if measured latency fails. Candidates (grounded):
   - `sqlite-vec` (Alex Garcia) — clean C, brute-force, virtual tables, **pre-v1** (0.1.x) ([repo](https://github.com/asg017/sqlite-vec)).
   - **`sqlite-vector`** (sqliteai / Marco Bambini) — vectors as BLOBs in ordinary tables, SIMD + quantization, "production-grade," ~30 MB, benchmarks faster than sqlite-vec ([sqliteai/sqlite-vector](https://github.com/sqliteai/sqlite-vector), [state of vector search in SQLite](https://marcobambini.substack.com/p/the-state-of-vector-search-in-sqlite)). Preferred to evaluate first.
   - Rejected: libSQL/Turso native vector (indexing reportedly hours at 100k vectors), `Vec1` (not released).
3. **Process model:** host the index + search/graph/health service in a **long-lived Electron `utilityProcess`** (Chromium-spawned Node child with MessagePort, purpose-built for "CPU-intensive/crash-prone" work — [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)), **not** the main process and **not** a per-query child. `worker_threads` is rejected for isolation: workers share the process, so a global OOM aborts everything ([Node worker_threads](https://nodejs.org/api/worker_threads.html)); a separate process is a true OOM boundary.
4. **Canonical vs derived:** Markdown stays canonical. The SQLite index lives under the app's local data dir (NOT inside the Obsidian/OneDrive-synced vault — WAL must not run on a network FS, [SQLite WAL](https://sqlite.org/wal.html)), is fully **rebuildable**, and is disposable.

## Options considered

| Option | Verdict | Why |
|---|---|---|
| A. Keep loading corpus, raise heap | ✗ | Main heap hard-capped ~4 GB; flag is a no-op (grounded above). |
| B. Per-query child process | ✗ | Each query cold-loads + reparses ~3.5 GB → multi-second latency, repeated GC/parse tax. |
| C. **Incremental on-disk index in a utilityProcess** | ✓ | Memory = O(batch + K), not O(corpus). Search latency from an index, not a re-scan. Electron-blessed isolation. |

Sub-decisions: better-sqlite3 over node:sqlite (FTS5 + sync API + maturity); vector extension behind an adapter (start exact); index outside the vault.

## Schema sketch (better-sqlite3, WAL mode)

- `files(relPath PK, kind, sizeBytes, mtimeNs, contentHash, indexedOffset, parserVersion, generation, errorState)`
- `chunks(chunkId PK, relPath, observationId, ordinal, byteStart, byteEnd, headings, text, textHash, generation)`
- `chunks_fts` — FTS5 over title/headings/body/tags/path (external-content or contentless-delete; keep content+FTS writes in **one transaction**, [FTS5 external content caveat](https://www.sqlite.org/fts5.html))
- `vectors(chunkId, modelId, dim, vec BLOB, generation)` (adapter-specific)
- `graph_nodes`, `graph_edges(edgeType, derivationVersion)`
- `jobs(id, priority, state, singleFlightKey, leaseExpiry, attempts, progress)`
- `meta(schemaVersion, parserVersion, embeddingModel, graphGeneration)`

Add a **stable observation id** to new raw markdown (frontmatter field or HTML-comment block id) — path+offset is not stable under edits; content-hash alone collides on duplicate observations.

## Incremental indexing

- `fs.watch()` enqueues *hints* only (it is not consistent across platforms — Windows rename/move may emit no events, [Node fs docs](https://nodejs.org/api/fs.html)).
- A periodic **reconciler** walks file metadata, compares path/size/mtime, hashes changed/suspicious files, marks a scan generation, and tombstones missing files **only after a complete scan**.
- Append-mostly raw: persist last indexed byte offset + a boundary anchor hash; tail-read when size grew and anchors match; reparse the file on mismatch (never the corpus).
- Large files: build a new per-file `generation` in **bounded transactions**, then atomically flip `files.generation` (search never sees a half-indexed 30 MB file).
- Bounded ingestion: explicit caps on record bytes, chunk bytes, rows/transaction, in-flight bytes; oversized/malformed records → quarantine, never an unbounded allocation.

## Search/graph/health over the index

- Lexical (FTS5 BM25) and vector retrieval each return bounded top-K; merge with **reciprocal-rank fusion**; rerank only a small bounded set; cursor-paginate. No JS corpus cache.
- Graph: serve neighborhoods / time-windows / level-of-detail from materialized edges; never one unbounded graph JSON.
- Health: O(1) state read (already done in Tier-1); a "ready/last-indexed-generation/pending" view from `meta`/`jobs`.

## Migration phases (each shippable; Codex implements, audit each)

1. **Instrument** index memory/latency on synthetic 1×/2×/5×/10× vaults (keep 20–30 MB outliers).
2. Stand up the **utilityProcess**; move the *existing* HTTP server into it unchanged (keeps the API); main only supervises + restarts.
3. Build the **SQLite catalog + FTS5 + reconciler + jobs** (app-data dir, WAL). Shadow-backfill; compare against the legacy loader while legacy still serves.
4. Cut **lexical search + graph + health** to the index; delete the in-process BM25 corpus cache. `[DROP the in-process full-corpus search path]`.
5. Cut **vector retrieval** behind the adapter (exact `sqlite-vec`/`sqlite-vector` first); measure recall vs legacy.
6. Rewrite auto-heal/auto-promote as **indexed incremental** jobs (only changed/missing rows).
7. Retire remaining full-corpus loaders; once *no path loads the corpus into the main heap*, confirm a CI run with a deliberately low old-space cap passes.

## Consequences / Risks (grounded)

- **Native packaging (biggest cost).** better-sqlite3 + the vector extension are native (`.node` / `dlopen`). The app currently ships a tsdown-bundled single `electron-main.mjs` with **no `node_modules`** — that model can't carry a native module. Tier-2 requires: shipping the native module, `electron-rebuild`/`@electron/rebuild` against Electron's ABI, per-platform CI builds (NODE_MODULE_VERSION mismatches otherwise — [electron-builder#5317](https://github.com/electron-userland/electron-builder/issues/5317), [electron/rebuild#591](https://github.com/electron/electron-rebuild/issues/591)), and (for packaged extension `.node` files) correct unpacking. The app already has one native dep (`sharp`) but it is **not currently shipped in the Electron bundle**, so the rebuild+ship path must be established. Windows arm64 + the vector extension need explicit attention.
- **Dual-write consistency** if vectors live outside the main DB — keep them in the same SQLite where possible; otherwise a durable outbox + generation checks.
- **Vector-extension maturity:** sqlite-vec pre-v1; sqlite-vector newer vendor. Adapter + exact baseline + a sampled recall test mitigate.
- **Index corruption / WAL on synced FS:** index in app-data, not the vault; rebuild into a new generation and atomically switch.
- **Approximate-index recall drift** if ANN is later enabled: keep a sampled exact baseline + recall@K monitor.

## Acceptance (what the audit checks, by side-effect not memory)

- A `scope=all` search on the 754 MB vault keeps the service process JS heap **bounded** (assert via `v8.getHeapStatistics` / RSS slope vs indexed-row count, on a deliberately low old-space cap), and returns correct top-K vs the legacy loader on a fixed query set.
- Index survives kill/restart, missing watcher events, a malformed 30 MB record, and disk-full (degrades to read-only over the last generation; never deletes canonical markdown).
- Packaged app: search/graph/health work from the installed Electron build (native module loads), verified by output.

## Sources

All accessed 2026-06-25. Node [v8](https://nodejs.org/api/v8.html) / [worker_threads](https://nodejs.org/api/worker_threads.html) / [sqlite](https://nodejs.org/api/sqlite.html) / [fs](https://nodejs.org/api/fs.html) docs; Electron [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) / [V8 memory cage](https://www.electronjs.org/blog/v8-memory-cage) / [#41248](https://github.com/electron/electron/issues/41248) / [#31330](https://github.com/electron/electron/issues/31330); SQLite [FTS5](https://www.sqlite.org/fts5.html) / [WAL](https://sqlite.org/wal.html); [sqlite-vec](https://github.com/asg017/sqlite-vec); [sqliteai/sqlite-vector](https://github.com/sqliteai/sqlite-vector) + [state of vector search](https://marcobambini.substack.com/p/the-state-of-vector-search-in-sqlite); better-sqlite3 Electron packaging ([electron-builder#5317](https://github.com/electron-userland/electron-builder/issues/5317), [electron/rebuild#591](https://github.com/electron/electron-rebuild/issues/591)).
