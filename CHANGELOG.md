# Changelog

All notable changes to Memory Fort are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.3] - 2026-06-16

### Fixed
- **`frontmatter.source` verify check no longer counts `log.md`** — the append-only audit trail has no frontmatter (and no `source`) by design, so it was permanently reported as a wiki page "lacking source provenance." The check now excludes any `log.md`, so a clean vault reports a true pass instead of a perpetual 1-page warning.

## [0.8.2] - 2026-06-16

### Documentation
- **README catch-up** — documented the compile cost-control features (pre-LLM raw filter, condensed index, daily keep-up drain, `--filter-report`, cost observability), core-memory `preferences` pages, and the `memory init` desktop shortcut, which had shipped in 0.7-0.8.1 without README coverage.
- **`docs/RELEASING.md`** — canonical release checklist so every public change ships with README + CHANGELOG + docs updates, a privacy scan, a rebuild, and a dashboard restart.

## [0.8.1] - 2026-06-16

### Fixed
- **Compile rewrites no longer clobber curated graph relations** — `rewrite_page` (and `write_page` on an existing page) now reads the target page's existing `relations` and UNIONs them with the LLM-emitted relations (per relation type, deduped by normalized target, dangling targets filtered) instead of replacing them. Previously a rewrite emitting only `derived_from` from the current batch would drop accumulated curated edges (`uses`/`depends_on`/`learned_from` to decisions/lessons/tools), degrading the typed graph. The `curation.content-loss` guard catches such drops; this fix preserves the edges at the source.

## [0.8.0] - 2026-06-14

Compile Cost Control & Core Memory Pages — pre-LLM noise filtering, condensed index injection, automatic core-memory page extraction, and full per-call cost observability.

### Added
- **Pre-LLM raw filter** (`src/compile/filter-raw.ts`) — strips tool-output noise from raw observations before they reach the compile LLM. Keeps user prompts, assistant responses/decisions, tool commands, findings prose, and signal lines (errors, diffs, commit lines, test counts, stack traces); prunes file dumps, base64/image data, ANSI, and long machine output. ~55% byte reduction corpus-wide, up to ~88% on large tool-heavy sessions, with ~96% hard-signal survival. STRIP-only — every file still reaches the LLM. Config `compile.raw_filter`.
- **Noise-only LLM skip** — a slice that is provably all-noise advances its watermark without an LLM call, so noise is consumed once and never re-billed.
- **Condensed index injection** (`src/compile/condense-index.ts`) — injects a compact title+path index instead of the full `index.md` each pass, cutting per-pass prompt overhead. Config `compile.condensed_index`, `index_desc_chars`, `index_max_bytes`.
- **`compile --filter-report [--json]`** — dry-run reporting per-file and aggregate filter reduction with no LLM calls and no writes; validate the filter before enabling it.
- **`compile.filter-health` verify check** — surfaces raw-filter reduction and backlog trend.
- **Daily keep-up drain** — scheduled compile can run a bounded `runCompileDrain` (`compile.drain`, `compile.max_passes_per_run`) so the raw backlog never accumulates.
- **Core memory pages** — `preferences` is now a first-class page type; `memory compile --execute` writes individual `wiki/preferences/<slug>.md` core-memory pages (`cognitive_type: core`) from explicit operator directives, deduped via the index.
- **Desktop shortcut on init** — `memory init` creates a desktop shortcut that launches the dashboard (Windows `.lnk`, macOS `.command`, Linux `.desktop`) for non-technical users.
- **Compile config knobs** — `raw_filter`, `raw_filter_min_signal_bytes`, `drain`, `max_passes_per_run`, `condensed_index`, `index_desc_chars`, `index_max_bytes`, plus a `resolveCompileConfig` normalizer.

### Changed
- Index rebuild now includes a **Preferences** section so core memory pages appear in the index and feed compile dedup.
- `backfill-source` infers `compile-execute` as the source for `wiki/preferences/` pages.
- Drain accounting counts noise-only consumption as progress and terminates cleanly without an LLM call on the trailing empty pass.

### Fixed
- **LLM audit `cost_usd` recorded for all OpenRouter models** — reads OpenRouter's per-call `usage.cost` with a static pricing-table fallback; previously only `gpt-4o-mini` rows had a cost, leaving spend on other models (e.g. Gemini) untracked.
- Empty compile passes no longer make an LLM call, while still preserving compressed-fact consolidation.
- `write_page` numeric-confidence gate narrowed to preferences pages only, so other page types keep the multi-source corroboration requirement.

## [0.7.0] - 2026-06-14

Reliability Hardening — cross-process locking, crash-resume journaling, local-model backfill, production bug fixes.

### Added
- **Cross-process file lock** (`src/storage/file-lock.ts`) — exclusive `O_CREAT|O_EXCL` lock with stale-lock breaking; locked read-modify-write for compile state, embeddings store, and sync state eliminates concurrent watermark/record loss
- **LLM call timeout** — configurable decorator (default 5 min, `llm.timeout_ms` in config.yaml) wraps all LLM calls to prevent indefinite hangs
- **Compile ops journal** — crash-resume idempotency; each vault-mutating operation is journaled after it lands, skipped on retry, cleared on watermark advance
- **`compile --backfill`** — makes unwatermarked raw files eligible regardless of the log-derived `since` cutoff while keeping watermark dedup, so pre-watermark history (1,300+ files) can be drained
- **Local-model backfill runner** (`scripts/backfill-local.ps1`) — runs backfill drain against a local LM Studio model; handles model loading, config swap, and always restores cloud config on exit
- **Single-instance mutex guard** — logon auto-resume shortcut cannot race an already-running drain on state.json
- **Drain quarantine** — after 2 consecutive zero-advance passes, quarantines the batch in-memory and continues with remaining files instead of killing the whole run
- **Rolling-health progress watcher** (`scripts/watch-backfill.ps1`) — success rate over last 10 passes, files advanced/included, cumulative quarantine count
- **4 new verify checks** — `storage.orphaned-tmp`, `retrieval.embeddings-integrity`, `sync.state-drift`, `compile.backlog-growth`
- **Core memory extraction** — compile prompt now scans for explicit operator directives ("always X", "never Y") and extracts them as core memories immediately (single-session threshold exemption)
- **Small-context compile knobs** — `--existing-pages-max-bytes` and `--max-files-per-pass` for fitting compile passes into small local-model contexts
- **`openai-compat` provider** accepted in config.yaml validator (factory already supported it)
- **`merge=union`** for raw observation files in `.gitattributes` — git merge concatenates instead of conflicting

### Changed
- Sync-state self-heal: `getSyncStatus` clears stale conflict flags when git shows no unmerged paths
- Compile drain skips files already fully covered by the compress lane
- Graph-health excludes single-node projects from subgraph density minimum calculation
- Entity merge now archives alias pages to `wiki/archive/` (status: archived, `superseded_by` provenance) instead of leaving duplicates live; archive excluded from dedup candidates and health metrics
- `relink-anchors --apply` records per-page skip reasons and continues instead of aborting the batch on the first problematic page
- Launcher readiness probe uses `/api/status` (cheap) instead of `/api/search` (cold-start timeout); degraded search is a warning, not a failure
- Resolved inbox proposals tracked in a ledger so drains cannot re-stage them

### Fixed
- **compile: watermark cursor** — `chooseSliceEnd` returning `startByte` on observation boundary allocated 0 bytes, freezing all drain progress
- **compile: fact consolidation shadowing** — permanently non-empty facts/ store blocked the prompt-based raw compile path; raw watermark never advanced
- **compile: duplicate context injection** — `{{schema_content}}` in prompt prose was substituted twice, silently doubling ~44KB of context in every prompt
- **compile: append-mode for log.md** — `atomicWrite` (tmp + rename) fails with EPERM when Obsidian holds log.md; switched to `atomicAppend`
- **compile: fence-tag matching** — local models emit `json` or untagged fences; parser now tries `compile-ops`, then falls back to any valid JSON fence
- **compile: weaker-model tolerance** — skip unsupported ops instead of rejecting entire response; strip `<think>` blocks; catch per-candidate synthesis failures; stall detection after 3 zero-advance passes
- **compile: procedure prompt budgeting** — 30-day scan produced 136k-token prompts; cap at 40 observations / 96KB per cluster
- **compile: `--drain` with `--since`** — `--since` bypasses drain watermarks, causing infinite re-send; now rejected
- **drain: transient failure recovery** — per-pass retry with 30s→8m backoff ladder; `backfill-local.ps1` relaunches every 5 min for up to 2 hours
- **drain: fact consolidation interception** — consolidation intercepted every pass and exited on "included 0"; drain now sets `skipFactConsolidation=true`
- **sync: git index.lock contention** — `commitVaultChange` retries with 250ms→2s backoff ladder
- **launcher: false failure dialog** — `$null -ne 0` is true in PowerShell; explicit `exit 0` on success
- **launcher: hidden window errors** — show MessageBox with launcher output on failure, always attempt browser open
- **init: gitignore runtime logs** — untracked log files blocked auto-push worker
- **atomic-write: orphaned .tmp cleanup** — unlink when rename exhausts retries
- **connect: missing chatgpt case** — `memory connect chatgpt` now works
- **install/chatgpt: Windows autostart** — include `process.execPath` in Run key command (`.mjs` not directly executable)
- **test: APPDATA env isolation** — prevent TLS cert leak across vitest worker threads in bridge tests

## [0.6.0] - 2026-06-10

Phase 2.0 Competitive Parity — temporal validity, published benchmarks, client SDKs, identity-aware retrieval.

### Added
- **Temporal validity fields** — `observed_at` (when a fact was observed), `valid_from` (when it became true), `valid_until` (when it ceased to be true, inclusive) on page frontmatter; documented in schema v1.5
- **Supersede temporal patches** — supersede proposals now carry `old_page_patch` (`valid_until` + `status: superseded`) as structured metadata; the old page is NOT mutated until human approval (staging invariant preserved); proposals marked `searchable: false`
- **`memory proposed approve <path>`** — crash-safe, idempotent approval path: archives the old page version to `wiki/.archive/`, stamps the temporal patch plus a top-level `superseded_by` provenance field, marks the proposal approved; validates proposal location, path traversal, and replacement-page existence before any write
- **`as_of` temporal search filtering** — search pipeline, dashboard API (`?as_of=`), and MCP `search` tool filter pages to those valid at a point in time; inclusive `[valid_from, valid_until]` semantics; untemporalized pages always pass; invalid dates return HTTP 400 (never silently ignored)
- **Benchmark scores in CI** — graph-aware retrieval eval runs against a deterministic checked-in fixture vault (`qa/fixtures/graph-aware-vault/`) with results in GitHub job summaries; `scripts/ci-eval-summary.mjs` renders markdown tables for both eval report shapes
- **`memory eval dispatch`** — dispatch policy eval testing the `classifyDispatch` truth table against `qa/dispatch-gold.jsonl` (10/10 on the bundled gold set); exits non-zero on any drift; wired into CI
- **TypeScript SDK (`packages/sdk`, npm `memory-fort-sdk`)** — `MemoryFortClient` with `add()` / `log()` / `search()` / `listPages()`, typed errors, identity + temporal search options
- **Python SDK (`packages/sdk-python`, PyPI `memory-fort`)** — async `MemoryFortClient` (httpx) with the same surface, PEP 561 typed
- **`POST /api/observations`** — log an observation over HTTP into the configured vault (origin + write-capability gated); **`GET /api/pages`** — list wiki page metadata with optional `?type=` filter; both implemented as extracted, unit-testable handlers
- **Identity tagging** — `MEMORY_FORT_AGENT_ID` / `MEMORY_FORT_USER_ID` env vars stamp validated `agent_id` / `user_id` (`[A-Za-z0-9._@-]{1,128}`) into raw session frontmatter at capture time; malformed values dropped, never stamped
- **Identity-aware search filtering** — `agent_id` / `user_id` / `identity_mode` on search API, MCP, and SDKs; inclusive mode (default) always passes untagged curated pages; strict mode returns only tagged matches; documented as a retrieval preference, NOT security isolation
- **SDK CI steps** — TypeScript SDK typecheck/test/build and Python SDK test/build on every push

### Changed
- `rawSessionFile` / `ensureRawSessionFile` / `appendBlock` accept an optional vault root override (used by the observations API; default behavior unchanged)
- Schema version bumped to 1.5 (temporal validity + identity tagging sections)

### Fixed
- Corpus now populates `rawFrontmatter` for every document kind — previously only raw observations carried it, making `as_of` and identity filtering silent no-ops on wiki pages (caught by live end-to-end verification)
- `memory-fort-sdk` package entry points now match tsdown output (`index.mjs`/`.cjs`/`.d.mts`/`.d.cts`) — previous paths pointed at nonexistent files, breaking every consumer install

### Documented
- Dashboard write endpoints require the vault to be a git repository; non-git vaults are read-only mirrors (HTTP 403) — noted in README and both SDK READMEs

## [0.5.1] - 2026-06-09

### Added
- **Capture-mode ingestion gate** — per-tool recording granularity via `capture.tools.<name>: full|summary|metadata|skip` in config.yaml; `exclude_patterns` glob list skips capture by file path; `full` mode unchanged as default
- **Summary and metadata block formatters** — `formatSummaryBlock` (512-byte output cap, secrets redacted) and `formatMetadataBlock` (input-only, no output) for reduced-fidelity capture modes
- **MCP `memory: false` opt-out** — callers can pass `memory: false` on `log_observation` to suppress capture without removing the hook
- **Stats capture mode reporting** — `memory stats` shows active capture config when non-default modes are set
- **contextualizedText embedding** — graph topology prepended as `#`-header context block before embedding body: path, type, relations, tags, backlinks (500-char cap, 10-backlink cap, deterministic sort); dual hash: `contentHash` (body only) + `contextHash` (context block); `contextV: 2` on embedding records; refresh pipeline updated to maintain dual hashes incrementally
- **Session index cards** — one-shot LLM extraction producing `schema_version`, `raw_sha256`, `topics`, `quotes`, `summary` JSON per raw session; SHA256 staleness check skips reprocessing unchanged sessions; `redactSecrets` applied to both LLM prompt and extracted quotes; compile batch selection scores sessions via index card topics
- **Similarity-assisted context selection** — `findSimilar()` brute-force cosine search against wiki embeddings; `selectSimilarContext()` and `buildSimilarityAwareContext()` wrappers; configurable threshold (`compile.similarity_context.threshold`, default 0.8); wired into compile pipeline
- **Lifecycle mutation dispatch** — `dispute_page` (mutually incompatible claim) and `supersede_page` (formerly true, now obsolete) as new `CompileOperation` kinds; proposals staged to `wiki/compile-proposed/` for human review, never auto-applied; `classifyDispatch()` authority check (similarity ≥ threshold AND newer session) downgrades to `rewrite_page` without authority; compile prompt updated with full operation spec and examples
- **Eval fixtures** — `qa/graph-aware-gold.jsonl` (12 graph-aware queries) and `qa/dispatch-gold.jsonl` (10 dispatch scenarios) for retrieval and dispatch regression testing

### Changed
- Embedding refresh now computes `contextHash` alongside `contentHash`; records missing `contextHash` are re-embedded on next refresh

## [0.5.0] - 2026-06-09

### Added
- **ChatGPT bridge** — HTTP/SSE MCP server on port 3100 for ChatGPT desktop; `memory chatgpt-bridge start|stop|status`, `memory install chatgpt`, `memory uninstall chatgpt`
- **Client toggles** — enable/disable any client (`clients.<name>: true|false` in config.yaml); disabled clients skip verify checks automatically
- **Secrets management** — API keys stored outside vault in OS config dir; validate-then-save via `/api/secrets`; masked display in dashboard
- **Search provenance** — every search result carries provenance receipts (which signals contributed, confidence breakdown)
- **Sync Now button** — `POST /api/sync` triggers auto-commit + push/pull from dashboard
- **OpenCode connector** — `memory install opencode`, hooks, verify checks, event capture
- **OpenCoven readiness check** — verify detects OpenCoven availability
- **VS Code extension** — MCP entry + extension install check in verify
- **Claude Desktop connector** — MCP entry + watcher source verify
- **Dashboard UI audit** — 33 findings remediated (a11y, keyboard nav, security headers, CSP)
- **Credibility proof** — v1.1 release evidence documentation

### Changed
- Auto-commit now accepts all vault-managed files (`wiki/*`, `embeddings/*`, `prompts/*`, `config.yaml`, `index.md`, `schema.md`, `preferences.md`) not just `raw/*` and a few whitelisted paths
- Dashboard errors activity shows all `errors.log` lines with parsed timestamps instead of single event with file mtime
- Config PATCH safelist expanded: `clients.opencode`, `clients.chatgpt`, `clients.vscode`, `clients.claude-desktop`
- License changed from PolyForm Noncommercial to GPL-3.0-only

### Fixed
- ChatGPT bridge PID file moved from vault root to `LOCALAPPDATA/memory-fort/` — was blocking auto-commit and sync
- Bridge spawn path resolved correctly from bundled CLI (`./mcp/` not `../../mcp/`)
- Bridge startup timeout increased 5s → 15s
- OpenCode verify checks skip when client disabled (was failing instead of skipping)
- CI pipeline: build step runs before typecheck:ui (routeTree.gen.ts dependency)
- NeedsAttention tests wrapped in QueryClientProvider (useMutation requirement)

## [0.4.0] - 2026-05-25

### Added
- **React 19 dashboard** — full SPA with TanStack Router, TanStack Query, Tailwind CSS
- Overview screen with stat cards, sparklines, recent activity, needs-attention alerts
- Wiki browser with markdown rendering, wikilinks, relations, TOC
- Raw observations browser with session detail view
- Sessions tile grid + crystals list
- Unified audit log with level/source filters
- 3D graph visualization (force/clustered/constellation/orbital/timeline modes)
- Graph search-highlight + path tracing
- Command palette (Cmd+K) wired to `/api/search`
- Dedicated search page with URL-backed filter state
- Settings page (read-only with CLI edit guidance)
- Compile, conflicts, and maintenance screens
- Mobile responsive pass
- Keyboard navigation + accessibility
- Claude Desktop MCP-only installer
- Dashboard JSON adapter endpoints (page, activity, timeline, graph, sync-state, config)
- VPS deployment integration (systemd services + timers)

## [0.3.0] - 2026-05-23

### Added
- **Retrieval pipeline** — BM25 lexical search, exact-match boosting, graph/metadata signals
- Voyage AI embeddings with hash-based incremental refresh
- RRF fusion + rerank wrapping with graceful Voyage fallback
- HyDE query expansion (prompt template + heuristic)
- `memory search` CLI command
- `/api/search` dashboard endpoint
- MCP `memory.search` tool — Claude/Codex/Antigravity can query via tool call
- Auto-sync — post-hook debounced background push to VPS
- Auto-commit raw observations before push
- `memory sync` / `memory pull` / `memory push` — conflict-aware sync state machine
- VPS systemd services + timers, Tailscale route
- Dashboard skeleton — read-only status from synced vault

## [0.2.0] - 2026-05-22

### Added
- **Curation commands** — `memory compile`, `memory lint`, `memory page`
- Compile prompt orchestrator — distills raw observations into wiki pages
- Lint with programmatic checks (frontmatter, broken wikilinks, broken relations, orphans, stale, drafts) + LLM prompt mode
- Page pretty-printer with resolved relations and inbound references
- Prompt templates (`compile.md`, `lint.md`) copied during `memory init`
- Extended frontmatter validation (relations, confidence, tags)

### Fixed
- Disable js-yaml date auto-cast (JSON_SCHEMA) — prevented date strings from becoming Date objects

## [0.1.2] - 2026-06-06

### Fixed
- Normalize repository URL in package.json
- Scan `dist/` for infrastructure tokens

## [0.1.1] - 2026-06-06

### Fixed
- Remove internal build chunk (`dist/private-ops-*.mjs`) from published tarball
- Delete VHS/infra command source files from build inputs

## [0.1.0] - 2026-05-21

### Added
- **Initial release** — CLI + hooks + MCP + raw capture
- Hook firehose: PreToolUse, PostToolUse, UserPromptSubmit, Stop
- MCP server with `log_observation`, `read_page`, `list_pages` tools
- Raw observation ingestion from Claude Code, Codex, Antigravity
- `memory init` interactive wizard
- `memory install` / `memory uninstall` for all supported clients
- `memory verify` diagnostic checks
- Typed-graph wiki with frontmatter schema
- Obsidian vault compatibility (graph view, backlinks, full-text search)
- Tri-OS CI (Ubuntu / macOS / Windows)
