# Phase 3 — Retrieval, MCP search tool, reranker, HyDE

**Spec:** `docs/superpowers/specs/2026-05-20-cross-tool-memory-system-design.md`
**Phase 2 tag:** `v0.2.0-phase2` (commit `4276753`)
**Date:** 2026-05-22
**Scope:** Retrieval over `~/.memory/` using in-process BM25, JSONL embedding sidecars, Voyage embeddings/rerank, RRF fusion, 1-hop graph expansion, `memory search`, and MCP `memory.search`. NO vector database. NO source-code behavior changes in this planning slice.

**Web grounding:** Voyage docs and npm were checked on 2026-05-22. The official TypeScript package is `voyageai`, current npm version `0.2.1`; plan Slice 1 should add `"voyageai": "~0.2.1"`. Voyage docs list `voyage-4-large` as current with 32k context and supported output dimensions `256`, `512`, `1024`, `2048`; `rerank-2.5` is current with 32k context. BM25 defaults `k1=1.2`, `b=0.75` are confirmed from search-engine docs and common Okapi BM25 defaults.

---

## Goals

- `memory search "<query>"` CLI returns top-K relevant pages or raw observations from `~/.memory/` with snippets and scores.
- `memory.search` MCP tool gives Claude Code / Codex / Antigravity sessions identical retrieval.
- Hybrid fusion: BM25 (lexical) + `voyage-4-large` embeddings (semantic) + 1-hop relations graph expansion, fused via Reciprocal Rank Fusion (RRF).
- Voyage Rerank 2.5 re-scores the top-K candidates.
- Optional HyDE query expansion via the in-session LLM when the query is short or has no BM25 exact match.
- Lazy, content-hash-driven re-embedding so embeddings stay current without scheduled jobs.
- Graceful degradation: if Voyage is unreachable, fall back to BM25 + graph with a one-line warning. Search never hard-fails.

## Acceptance criteria

- `memory search "agentmemory codex stability"` against the current 15-raw / 0-wiki corpus returns at least one ranked result with snippet.
- `memory search "broken-link" --scope wiki` against a wiki populated by a curation pass returns the relevant wiki page in the top 3.
- `memory.search` MCP tool callable from a real Claude Code session; returns the same ranked results as the CLI for the same query and flags.
- All Phase 1 and Phase 2 tests still pass (regression guard).
- Real Voyage API call exercised in the checkpoint slice (not just mocked).
- `--no-rerank`, `--no-hyde`, `--scope wiki|raw|both`, `--k N`, `--min-score F`, and `--json` flags all functional.
- Embeddings sidecars persist between runs; second `memory search` reuses cached vectors when content hash matches.
- If `VOYAGE_API_KEY` is unset or Voyage errors, search emits one warning and still returns BM25 + graph results when lexical matches exist.
- `memory search --json` output is stable enough for MCP and future automation: `{ query, results, warnings, timings }`.
- All new source files have focused unit tests before CLI/MCP wiring lands.
- The final checkpoint records real latency for BM25-only, embedding-enabled, and rerank-enabled searches.

## Out of scope

- Voyage multimodal embeddings (text-only for Phase 3).
- Chunking strategies beyond a single fixed-size split on heading boundaries.
- Re-embedding on file-watcher (lazy on next search is sufficient for Phase 3).
- Multi-vector dense retrieval beyond one vector per chunk plus chunk-to-page aggregation.
- Pinecone / lancedb / sqlite-vec / Chroma / Qdrant — explicitly rejected per spec §29 and the sidecar principle.
- Graph query tools beyond `memory.search` unless a later Phase 3 addendum scopes them. The design spec mentions graph query operations, but this plan is the retrieval/search slice.
- Implicit graph extraction during compile. The design spec lists it near Phase 3, but the current plan keeps it deferred because Phase 2 compile is already stable and this phase is search-focused.
- Search result editing or curation suggestions. Retrieval returns candidates; it does not mutate `wiki/`, `raw/`, `index.md`, or `log.md`.
- Replacing `memory grep`. Exact-string grep remains the cheapest tier and stays available.
- A persistent search index process. Every search invocation can rebuild lightweight in-memory BM25/graph state from files.

## Step-by-step slices

For each slice: one-line goal, scope (files), and acceptance check. Do not write the Codex prompts here — those happen in implementation.

### Slice 1 — Voyage SDK integration and config plumbing

- Goal: wire the official Voyage TypeScript SDK into the codebase. Read API key from env (`VOYAGE_API_KEY`) with optional override in `config.yaml` (`voyage.api_key`). Add a small client wrapper at `src/retrieval/voyage-client.ts` exposing `embed(texts, inputType)` and `rerank(query, docs)`.
- Files: `package.json` / `package-lock.json` (add `voyageai` as `"~0.2.1"`), `src/retrieval/voyage-client.ts` (new), `src/storage/config.ts` (new config reader; there is no current config module), `test/retrieval/voyage-client.test.ts` (new; mock the SDK at the module boundary).
- Acceptance: unit tests pass with mocked SDK; manual smoke test gated behind `VOYAGE_API_KEY` calls a real embedding endpoint with `model: "voyage-4-large"`, `input_type: "document"`, `output_dimension: 2048`, and receives one 2048-dim vector.
- Notes: no real network calls in unit tests. The wrapper should normalize SDK exceptions into a typed `VoyageUnavailableError` so search fallback is straightforward.
- Test shape: exactly cover env-key resolution, config override precedence, embed argument mapping, rerank argument mapping, missing-key error, and SDK-error normalization.
- Manual smoke: `node -e` or a temporary script should print `dims=2048` and token count if the SDK exposes it. Do not commit smoke scripts.
- Config reader: keep it small. Parse `config.yaml` only for keys needed now (`voyage.api_key`, future `search.hyde`), and tolerate missing or malformed config by returning defaults plus warnings.

### Slice 2 — Embeddings JSONL sidecar storage

- Goal: read/write `~/.memory/embeddings/wiki.embeddings.jsonl` and `~/.memory/embeddings/raw.embeddings.jsonl`. Each line: `{"path":"<rel-path>","hash":"<sha256>","vector":[...],"model":"voyage-4-large","dim":2048,"ts":"<iso>"}`. Add `embeddings.meta.json` with provider, model, dim, SDK package, and created/updated timestamps.
- Files: `src/retrieval/embeddings-store.ts` (new), `test/retrieval/embeddings-store.test.ts` (new).
- Acceptance: write 100 records, reload them, preserve vectors and hashes exactly; removing 10 absent paths drops those records; malformed JSONL lines are skipped with a returned warning instead of crashing search.
- Notes: storage stays JSONL sidecar only. Do not introduce SQLite or a vector DB.
- API sketch: `loadEmbeddings(kind)`, `saveEmbeddings(kind, records)`, `addEmbedding(kind, record)`, `removeStale(kind, knownPaths)`, `loadEmbeddingMeta()`, `saveEmbeddingMeta(meta)`.
- Path rules: `kind` is only `"wiki"` or `"raw"`; sidecar paths are derived from `memoryRoot()` and never accepted as arbitrary user input.
- Write rules: use atomic temp-write-and-rename for full saves. JSONL append is allowed only for `addEmbedding` if it cannot corrupt existing records.
- Test shape: verify directories are created lazily, records sort by path for deterministic diffs, and duplicate path records collapse to the newest record.

### Slice 3 — Corpus loaders for wiki and raw

- Goal: build a shared `SearchDocument[]` snapshot for `wiki`, `raw`, or `both`. Wiki uses `loadWiki()` from `src/curation/checks.ts`; raw walks `~/.memory/raw/**/*.md`. Each document includes `kind`, relative path, full path, title, text, frontmatter, mtime, and a snippet source.
- Files: `src/retrieval/corpus.ts` (new), `test/retrieval/corpus.test.ts` (new).
- Acceptance: against a temp memory root with two wiki pages and three raw files, `loadSearchCorpus({ scope: "both" })` returns five documents with stable forward-slash paths and no filesystem writes.
- Notes: this is the boundary between I/O and pure retrieval functions. Later scorer modules accept `SearchDocument[]` and do no disk reads.
- Raw title: prefer frontmatter title when present; otherwise derive from filename.
- Wiki text: concatenate title, tags, relation keys/targets, and body so lexical search can hit both metadata and prose.
- Raw text: include frontmatter and body because raw sessions encode useful source/session/cwd metadata.
- Test shape: cover empty wiki, missing raw directory, malformed raw frontmatter fallback, and scope filtering.

### Slice 4 — Lazy refresh + content-hash detection

- Goal: `refreshEmbeddings(kind, docs, voyageClient)` computes SHA256 of each document text, compares against stored hashes/model/dim, batches mismatches through `voyageClient.embed`, writes back, and removes records for files no longer present.
- Files: `src/retrieval/refresh.ts` (new), `test/retrieval/refresh.test.ts` (new). The refresh function takes a `voyageClient` parameter for dependency injection.
- Acceptance: first call against a 10-document corpus embeds all 10; second call with no changes embeds 0; modify one document, third call embeds 1; remove one document, fourth call prunes 1 stale record.
- Notes: records whose `model !== "voyage-4-large"` or `dim !== 2048` are treated as stale even if the content hash matches.
- Batch size: start conservative, e.g. 64 documents per embed call, and expose it as an internal option for tests.
- Chunking: documents above the token threshold are split before embedding; each chunk record should include `chunkIndex`, `chunkCount`, and `parentPath`.
- Hashing: hash the exact string sent to embedding after chunking metadata decisions, not the raw file bytes.
- Test shape: verify unchanged chunks are reused and only modified chunks re-embed.

### Slice 5 — BM25 implementation

- Goal: in-process BM25 scorer. Tokenize by lowercasing, splitting on non-letter/number runs, and dropping empty terms. Compute IDF and BM25 with `k1=1.2`, `b=0.75`.
- Files: `src/retrieval/bm25.ts` (new), `test/retrieval/bm25.test.ts` (new). No new dependencies.
- Acceptance: against a 5-doc corpus, exact-match queries rank the canonical doc first; partial-match queries rank correctly; empty query returns no results; score ties break deterministically by path.
- Notes: expose `tokenize`, `buildBm25Index`, and `scoreBm25` as pure functions for testability.
- Formula: use standard Okapi BM25 with document length normalization. Do not add query term frequency weighting unless a later slice proves it is needed.
- Stopwords: do not remove stopwords in Phase 3; predictable behavior beats a hidden list.
- Unicode: keep Arabic and non-Latin letters by using Unicode-aware regex where Node supports it.
- Test shape: include punctuation, case folding, repeated terms, and a query with no corpus terms.

### Slice 6 — Vector scoring and snippet helpers

- Goal: cosine-similarity scoring over cached embeddings and query vectors, plus deterministic snippet extraction for CLI/MCP output.
- Files: `src/retrieval/vector.ts` (new), `src/retrieval/snippets.ts` (new), tests for each.
- Acceptance: cosine scoring ranks known vectors in expected order; zero vectors are ignored; snippets prefer query-term windows and fall back to the first non-empty body text.
- Notes: if a wiki page is chunked, aggregate chunk scores to the page by max score and retain the best chunk snippet.
- Score normalization: keep raw cosine internally; let RRF consume rank order rather than normalized score values.
- Snippet length: default around 240 characters, with ellipses only when text is actually clipped.
- Highlighting: do not add ANSI color in Phase 3; plain text is easier for MCP and JSON output.
- Test shape: include multi-line snippets and ensure snippets never throw on empty text.

### Slice 7 — RRF fusion + graph expansion

- Goal: `rrfFuse(rankedLists, k=60)` implements standard RRF. `expandViaGraph(topPaths, pages, hops=1)` adds pages linked by `[[wikilinks]]` and `relations:` to the candidate set.
- Files: `src/retrieval/rrf.ts` (new), `src/retrieval/graph-expand.ts` (new), `test/retrieval/rrf.test.ts` (new), `test/retrieval/graph-expand.test.ts` (new).
- Acceptance: RRF over two known ranked lists produces the canonical fused order; graph expansion against a 3-page wiki with one relation and one inline wikilink pulls both target pages into the candidate set.
- Notes: duplicate the local resolution helper style from `page.ts` / `checks.ts` rather than exporting private lint helpers.
- RRF output: include per-source contributions for debugging: `{ path, score, sources: ["bm25", "vector"] }`.
- Graph expansion score: graph-only candidates should enter as a separate ranked list after their source pages, not receive synthetic cosine/BM25 scores.
- Direction: include outgoing relations and incoming backlinks for one-hop expansion. Record direction in debug metadata.
- Test shape: ambiguous filename-only wikilinks should not resolve; full-path wikilinks should resolve.

### Slice 8 — Search core orchestrator (`runSearch`)

- Goal: tie everything together. `runSearch(query, opts, deps)` loads corpus → refreshes embeddings lazily when allowed → embeds query (or HyDE expansion text) → BM25 top-50 → cosine top-50 → graph 1-hop expansion → RRF fuse → optional Voyage rerank → apply `k` and `minScore` → return structured results plus warnings.
- Files: `src/retrieval/search.ts` (new), `test/retrieval/search.test.ts` (new, DI'd with mock Voyage client and temp storage).
- Acceptance: deterministic results given a fixed corpus and fixed mock embeddings; Voyage unavailable path returns BM25 results with one warning; `scope`, `k`, `minScore`, `noRerank`, and `noHyde` options alter the pipeline as expected.
- Notes: `runSearch` is the backend used by both CLI and MCP. Keep all ranking functions pure; isolate filesystem and Voyage calls behind injected dependencies.
- Result shape: `{ path, title, snippet, score, source, sources, kind }`; `source` is the final dominant source (`"rerank"` if reranked).
- Timing shape: include rough timings per stage for checkpoint reporting: corpus, refresh, bm25, vector, graph, rerank.
- Error policy: only programmer errors throw. Missing key and network failures become warnings plus degraded results.
- Test shape: one fixture should prove rerank reorders RRF output.

### Slice 9 — `memory search` CLI

- Goal: wire `runSearch` into a CLI command with flags `--k N`, `--scope wiki|raw|both`, `--min-score F`, `--no-rerank`, `--no-hyde`, `--json`. Pretty-print results (rank, score, path, source, snippet) or emit JSON.
- Files: `src/cli/commands/search.ts` (new), `src/cli.ts` (wire command and remove `search` from `registerStub`), `test/cli/commands/search.test.ts` (new), `test/cli/stubs.test.ts` (remove `search` from stub list).
- Acceptance: `node dist/cli.mjs search "foo" --json` produces parseable JSON; `--no-hyde --no-rerank` skips both stages; unset `VOYAGE_API_KEY` prints one warning to stderr and still returns BM25 hits when present.
- Notes: mirror the Step #12 spawnSync pattern for CLI integration tests after building `dist/cli.mjs`.
- Pretty format: first line should state query, result count, and any degradation warning. Each result then prints rank, score, path, and snippet.
- JSON format: warnings go in JSON, not stderr, unless there is also a human-facing warning from fallback.
- Exit codes: 0 for successful search even with fallback; 1 for internal errors; 2 for invalid flags.
- Test shape: include exactly one spawnSync test for stdout/stderr separation and one unit test for pretty formatting.

### Slice 10 — HyDE prompt template + orchestration

- Goal: add `templates/prompts/hyde.md` and a heuristic that decides when HyDE is useful: query has ≤ 5 words OR BM25 has no exact term match. The CLI assembles a HyDE prompt; the in-session LLM expands it; the expanded text becomes the embedding input. The CLI does not call an LLM directly.
- Files: `templates/prompts/hyde.md` (new), `src/cli/commands/init.ts` (copy `hyde.md` alongside `compile.md` and `lint.md`), `src/retrieval/hyde.ts` (new), updates to `src/retrieval/search.ts` and `src/cli/commands/search.ts`, tests.
- Acceptance: short query triggers HyDE prompt emission unless `--no-hyde` is set; user-supplied expanded text via stdin or `--hyde-input <path>` reaches the embedding call; `memory init` preserves an existing user-edited `~/.memory/prompts/hyde.md`.
- Notes: `hyde.md` should stay under 30 lines. HyDE is orchestration, not an API call.
- CLI UX: when HyDE is needed but no expanded text is supplied, print the prompt and clear instructions for piping the expanded answer back into search.
- Search UX: `--no-hyde` must never print a HyDE prompt.
- Template variables: keep them minimal, likely `{{query}}`, `{{schema_summary}}`, and maybe `{{bm25_context}}`.
- Test shape: assert no unresolved `{{...}}` template markers remain in emitted HyDE prompts.

### Slice 11 — MCP `memory.search` tool

- Goal: extend `src/mcp/server.ts` with `memory.search` using the same `runSearch` backend. Input schema mirrors CLI flags. Output is a text summary plus machine-readable JSON payload when the SDK response shape allows.
- Files: `src/mcp/server.ts` (extend, do not rewrite), `test/mcp/server.test.ts` (extend).
- Acceptance: existing `log_observation`, `read_page`, and `list_pages` tests still pass; a `memory.search` tool call with mock retrieval deps returns ranked `{ path, snippet, score, source }` results; real Claude Code session can call the tool against local memory.
- Notes: preserve stdio-only MCP. Do not add a server, daemon, port, or persistent in-process cache.
- Tool name: follow current server naming style. Existing tools are registered without the `memory.` prefix inside the server; host-facing name becomes part of the memory server namespace.
- Input schema: `query` required; `k`, `scope`, `min_score`, `no_rerank`, `no_hyde` optional.
- Output: include warnings prominently so the LLM knows when results are BM25-only.
- Test shape: add one test that proves old tools still register or still execute after adding search.

### Slice 12 — Docs (cli.md, architecture.md, retrieval-workflow.md)

- Goal: document `memory search`, add a Retrieval architecture section to `architecture.md`, and create `docs/retrieval-workflow.md` as a sibling of `curation-workflow.md`.
- Files: `docs/cli.md`, `docs/architecture.md`, `docs/retrieval-workflow.md` (new).
- Acceptance: docs explain scope flags, fallback behavior, sidecar embeddings, no-vector-DB rationale, HyDE handoff, and how MCP search relates to CLI search.
- Notes: docs should link retrieval back to curation: search quality depends on compile turning raw observations into durable wiki pages.
- `docs/cli.md`: match existing command-section style and include exit codes.
- `docs/architecture.md`: show flow `raw/wiki -> corpus -> BM25/vector/graph -> RRF -> rerank -> result`.
- `docs/retrieval-workflow.md`: include "when to grep vs search", "when to disable rerank", and "how to inspect embeddings sidecars".
- Test docs by reading them, not by adding doc tooling in Phase 3.

### Slice 13 — CHECKPOINT (real Voyage API call)

- Goal: dogfood against the real `~/.memory/` and a real Voyage API key. Confirm: wiki embeddings no-op gracefully when the wiki is empty; raw BM25 returns hits from the 15 accumulated raws; real embedding and rerank calls work when `VOYAGE_API_KEY` is set; fallback works when it is unset.
- Files: docs memo only — `docs/superpowers/notes/2026-05-22-phase-3-checkpoint.md`.
- Acceptance: memo records exact command output, API costs or token counts if available, latency numbers, generated sidecar sizes, fallback output, and any surprises.
- Notes: if a blocking retrieval bug surfaces, stop and file the finding instead of tagging.
- Commands: include at least one `memory search` default run, one `--no-rerank --no-hyde`, one `--scope raw`, one `--scope wiki`, one `--json`, and one missing-key fallback run.
- Sidecar audit: record `Get-Item ~/.memory/embeddings/*.jsonl` sizes and first/last JSONL lines if non-empty.
- Cost audit: if Voyage dashboard or SDK response gives usage, record it; otherwise record "usage not exposed by SDK response".
- Cleanup: do not delete real sidecars after checkpoint; they are part of dogfooding.

### Slice 14 — Tag `v0.3.0-phase3`

- Goal: annotated tag with Phase 3 release notes after tests, build, real search smoke, and checkpoint memo are green.
- Files: none.
- Acceptance: `git describe --tags` returns `v0.3.0-phase3`; tag message names BM25, Voyage embeddings, rerank, HyDE, RRF, MCP search, fallback behavior, and test count.
- Pre-tag gate: clean worktree, `npm test`, `npm run build`, checkpoint memo committed, `git tag --list` does not already include `v0.3.0-phase3`.
- No push unless explicitly requested.
- Tag message should mention real Voyage smoke status and whether raw embeddings are enabled by default.

## Boundaries

- **No vector database.** Spec is locked. Anyone suggesting Pinecone/sqlite-vec/lancedb/Chroma/Qdrant gets pointed to the sidecar decision and §29.
- **No real Voyage calls in unit tests.** Mock the SDK at the module boundary. Real calls happen only in smoke tests and Slice 13.
- **Lazy refresh, not scheduled.** Resist file-watchers, cron, background jobs, or automatic daemon refresh. Phase 3 refresh happens on search.
- **No multimodal embeddings.** Text-only.
- **Voyage SDK version:** use official npm package `voyageai` pinned as `"~0.2.1"` unless Slice 1 web-check finds a newer 0.2 patch. Do not use a caret-major range.
- **Backwards compatibility:** existing MCP tools (`log_observation`, `read_page`, `list_pages`) must continue to work. Extend `src/mcp/server.ts`; do not replace it.
- **Fallback is required behavior, not a best effort.** Voyage outage, missing key, quota error, or SDK import failure must still return lexical/graph results where possible.
- **Scope separation:** retrieval primitives live in `src/retrieval/`; CLI formatting lives in `src/cli/commands/search.ts`; MCP tool wiring stays in `src/mcp/server.ts`.
- **No new BM25 dependency.** Implement BM25 in TypeScript.
- **No silent empty results when fallback has matches.** If semantic search fails but BM25 has hits, return those hits.
- **No raw prompt flooding.** CLI commands that write output files should follow the Step #12 pattern: confirmation on stderr, large content in the file.
- **No lockfile churn except Slice 1.** Only the SDK installation slice should modify dependency metadata.
- **No OneDrive paths.** Continue the established project convention: source repo work happens under `C:\CodexProjects\memory-system`.

## Risks

- **Voyage API outage or quota exhaustion.** Mitigated by BM25 + graph fallback; warning printed once per search invocation.
- **Embedding drift between Voyage model versions.** Mitigated by `model` and `dim` fields in JSONL records; mismatched records auto-re-embed.
- **JSONL file growing unbounded.** Wiki is bounded by curated pages; raw is bounded by the future retention policy. Phase 3 adds prune-on-known-paths and no background growth.
- **SDK surface mismatch.** The official docs show Python examples more prominently than TypeScript. Slice 1 must inspect `voyageai` 0.2.x types before finalizing wrapper calls.
- **Chunking complexity.** Heading-boundary chunking can drift into a full parser. Keep it simple: split by headings, then by approximate token budget.
- **HyDE can over-broaden queries.** Keep it opt-in by heuristic, disable with `--no-hyde`, and show the expanded text in verbose/debug output.
- **SpawnSync CLI tests can depend on stale dist.** Follow the Step #12 pattern: build before CLI-spawn tests that execute `dist/cli.mjs`.

## Open questions to confirm before Slice 1

- Confirm the exact `voyageai` TypeScript SDK method names and result shapes in version `0.2.x`. The package is official and current at `0.2.1`, but Slice 1 should inspect installed types before implementing wrappers.
- Confirm whether `voyage-4-large` should use `output_dimension: 2048` everywhere or whether query embeddings should use `voyage-4-lite` at the same dimension for latency, relying on Voyage 4 shared embedding spaces. The locked spec says `voyage-4-large`; default to that unless the user explicitly chooses the mixed model.
- Confirm whether raw embeddings are enabled by default in Phase 3 or BM25-only for raw is enough until Phase 6 retention. The acceptance criteria require raw search over the current 15 raws; that can be BM25-first with optional raw embeddings.
- Confirm token-counter strategy for chunking. If the Voyage SDK exposes tokenization, use it; otherwise start with `chars / 4` approximation and document the approximation.

---

## Notes for the implementer

The Phase 2 retrospective showed that explicit numbered test cases, exact output templates, and deviation-honesty reminders prevent consolidation and reinterpretation mistakes. Phase 3 prompts should keep using those levers.

Phase 3 is more I/O-heavy than Phase 2: real network calls, real file persistence, real bytes-on-disk sidecars. Every slice that touches CLI or storage needs a manual smoke step after unit tests. The checkpoint must exercise the real `~/.memory/` and leave sidecar files inspectable.

The repo already has the separation pattern Phase 3 needs: `src/curation/checks.ts` keeps pure checks over snapshots, while `src/cli/commands/compile.ts` handles filesystem orchestration and prompt assembly. Follow that split. Search ranking should be pure over `SearchDocument[]` and vectors; only corpus loading, embedding refresh, and CLI/MCP wiring touch I/O.

Verification for this planning slice: only this file should be added. No source, test, package, or lockfile changes belong in the plan commit.

Implementation prompt style should remain strict:

- State exact pre-flight commit/tag expectations.
- Deliver an exact number of tests when the behavior is easy to over-consolidate.
- Require red phase before implementation for bug fixes and new CLI behavior.
- Require focused tests before full-suite tests.
- Require manual smoke for every slice that touches `dist/cli.mjs`, real `~/.memory/`, or Voyage.
- Require an honest deviations section in every final report.
