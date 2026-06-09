# Changelog

All notable changes to Memory Fort are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
