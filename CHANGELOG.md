# Changelog

All notable changes to Memory Fort are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-06-19

### Added
- **Desktop app (Electron) with native binary installers** — Memory Fort now ships as an installable desktop application for **Windows** (NSIS `.exe`), **macOS** (`.dmg`, Intel + Apple Silicon), and **Linux** (`.AppImage`), in addition to the npm package. The app wraps the existing dashboard in a native window — no browser tab, no per-launch rebuild. The Electron main process (`electron/main.ts`) starts the dashboard HTTP server **in-process** (no sidecar / child process) via `runDashboard({ noOpen: true })` and loads it in a `BrowserWindow`, with a single-instance lock and external links routed to the system browser. New `electron:dev` / `electron:build` scripts; `electron-builder.yml` defines all three targets and publishes to GitHub Releases. Installers are **unsigned** — Windows SmartScreen / macOS Gatekeeper will warn on first run (click through to proceed).
- **Cross-platform release workflow** (`.github/workflows/release.yml`) — a tag push (`v*`) fans out a Windows/macOS/Linux build matrix and attaches each installer to a GitHub Release automatically.
- **Tri-OS Electron launch smoke** (`.github/workflows/smoke.yml`) — boots the actual Electron shell headless on Windows, macOS, and Linux runners and asserts the in-process dashboard answers `200`, verifying the desktop build on every platform without a physical machine.

## [0.8.6] - 2026-06-18

### Fixed
- **Verify per-check timeout no longer false-fails slow checks** — 0.8.5's per-check hang backstop (15s) was shorter than some legitimately-slow checks: `git.integrity` (full `git fsck` on a large vault plus a remote SSH fsck) and `search.pipeline` (a real embedding query) timed out and reported false failures. The default backstop is now 60s, `CheckDescriptor` accepts a per-check `timeoutMs` override, and `git.integrity`/`search.pipeline` are set to 120s. A genuinely hung check is still bounded (no infinite freeze of `/api/health`).
- **`git.durability-config` reports the real cause when `core.fsync` is unset** — `git config --get core.fsync` exits 1 on an unset key, which previously surfaced the misleading "check git installation and vault permissions"; it now reports "core.fsync not set" with the remediation command.

## [0.8.5] - 2026-06-18

Reliability Hardening (Phase 1) — close the silent byte-loss (git corruption) and silent meaning-loss (LLM truncation, content-blind watermark) failure classes that caused prior incidents. Derived from `docs/reliability-assessment.md`.

### Added
- **Git durability config on init** — `memory init` now sets `core.fsync=committed`, `core.fsyncMethod=batch`, and `fetch.fsckObjects`/`transfer.fsckObjects=true` on the vault repo, so loose objects survive power-loss (the root cause of the empty-object corruption incidents) and corrupt objects are rejected in transit. The VPS bare repo gets the equivalent (`core.fsync`, `receive.fsckObjects`) as a documented setup step.
- **`git.integrity` verify check** — runs `git fsck --full --strict --no-dangling` on the local vault and (over SSH) on the VPS bare repo, hard-failing on real corruption (missing/broken/corrupt objects) while ignoring benign dangling/diagnostic output. Detection for the both-copies-corrupted class that `git.remote` (reachability only) could not catch.
- **`git.durability-config` verify check** — asserts `core.fsync` is applied.
- **`compile.raw-append-only` verify check** — flags any `raw/` file that shrank below its compile watermark (interim detection for the content-blind byte-count cursor; the full content-hashed cursor is Phase 2).
- **`build.version-match` verify check** — asserts the baked CLI/dashboard build version matches `package.json`, catching the stale-dashboard footgun.
- **Cross-process compile mutex** — `runCompile` now holds a vault-wide lock so a manual `memory compile` cannot race the scheduled drain and double-apply operations.

### Fixed
- **LLM truncation no longer silently drops data** — compile refuses to apply output (and does not advance the watermark) when the LLM `finishReason` is `length`/`filter`; narrative detect/synth throw to the staged-for-review path and truncated fact extraction stages a proposal instead of persisting partial facts.
- **One bad/hung verify check can no longer blank the health surface** — the verify orchestrator now isolates each check in try/catch and bounds it with a per-check timeout, synthesizing a `fail` result instead of aborting or freezing `/api/health`.
- **Stale-lock breaking is now liveness-aware** — `withFileLock` records the holder's host and only breaks a past-stale lock when the recorded process is provably gone (`process.kill(pid, 0)` / foreign host / unparseable), so a slow-but-alive holder (e.g. a long embedding rebuild) is never robbed of its lock.
- **`.sync-state.json` writes are now locked and corrupt-tolerant** — all writes route through the locked `mutateSyncStateFile` (no more unlocked write racing the auto-push worker), and a malformed state file falls back to defaults instead of bricking sync.
- **Secrets are written atomically** — `writeSecret` uses `atomicWrite` (+ `0600` on POSIX), so a crash can no longer truncate the only copy of API keys.

## [0.8.4] - 2026-06-17

### Fixed
- **Sync no longer deadlocks on a stale conflict flag** — `memory sync` (and the background auto-push worker) previously aborted with exit 3 whenever `.sync-state.json` recorded `conflicts_pending > 0`, reading that raw flag *before* the self-heal in `getSyncStatus` could run. A transient failure (e.g. an unreachable or corrupt backup remote) or a since-resolved rebase conflict left the flag set, and the worker re-armed it every cycle — wedging sync permanently until the file was hand-edited. `runSyncMode` now defers to `getSyncStatus`, which clears a stale flag when `git ls-files -u` shows no unmerged paths and reports `conflicted` only for genuine unmerged paths, so sync self-recovers. A real unresolved conflict still pauses sync with exit 3.
- **Dashboard no longer shows a phantom "conflict pending" banner** — the dashboard's `loadSyncState` read `conflicts_pending` straight from `.sync-state.json` with no reconciliation, so a stale flag rendered a red "unresolved sync conflicts" banner that never cleared on a dashboard-only machine (where nothing runs `memory sync` to trigger the self-heal). It now performs the same lightweight `git ls-files -u` reconciliation as the `sync-state-drift` check — only when a conflict is recorded — and displays a clean state when git confirms no unmerged paths, while conservatively keeping the banner if git reports unmerged paths or is unavailable.

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
