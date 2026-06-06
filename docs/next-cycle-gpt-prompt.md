<!--
CURRENT STATE SUMMARY (internal, not part of GPT prompt)

- Version:
  - package.json reports memory-fort version 0.1.2.
  - src/cli.ts still reports Commander version 0.1.0.
  - Some generated Claude Code plugin metadata also still uses 0.1.0.

- Commands implemented:
  - memory-fort init
  - memory-fort install <platform>
  - memory-fort uninstall <platform>
  - memory-fort connect [client]
  - memory-fort disconnect [client]
  - memory-fort auto-heal <status|enable|disable|tick>
  - memory-fort supervisor status
  - memory-fort sync-prompts
  - memory-fort grep <pattern>
  - memory-fort log <text>
  - memory-fort link-raw
  - memory-fort discover-threads
  - memory-fort compress
  - memory-fort compile
  - memory-fort reindex
  - memory-fort curate [page]
  - memory-fort compact-raw
  - memory-fort consolidate
  - memory-fort lint
  - memory-fort page <target>
  - memory-fort prune
  - memory-fort decay
  - memory-fort migrate-to-narrative
  - memory-fort relink-anchors
  - memory-fort provider list-embedders
  - memory-fort provider test-embedder
  - memory-fort provider reindex-embeddings
  - memory-fort provider rebless-embeddings
  - memory-fort provider list-llms
  - memory-fort provider test-llm
  - memory-fort provider test-classifier
  - memory-fort provider audit-summary
  - memory-fort provider audit-rotate
  - memory-fort import-agentmemory
  - memory-fort rewrite-imported-timestamps
  - memory-fort backfill
  - memory-fort backfill-source
  - memory-fort stats
  - memory-fort doctor
  - memory-fort verify
  - memory-fort watch
  - memory-fort tail-errors
  - memory-fort search <query>
  - memory-fort dashboard
  - memory-fort entity dedup
  - memory-fort entity merge <canonical>
  - memory-fort entity reject <canonical>
  - memory-fort entity aliases
  - memory-fort eval longmemeval
  - memory-fort eval download
  - memory-fort procedure propose
  - memory-fort procedure promote <slug>
  - memory-fort procedure reject <slug>
  - memory-fort thread propose
  - memory-fort thread promote <slug>
  - memory-fort thread reject <slug>
  - memory-fort eval-retrieval

- Commands stubbed:
  - Hidden unless MEMORY_FORT_SHOW_STUBS=1.
  - memory-fort crystallize prints a Phase 4 not-yet-implemented message and exits 2.
  - memory-fort backup prints a Phase 6 not-yet-implemented message and exits 2.
  - memory-fort import-from-agentmemory prints a Phase 5 not-yet-implemented/deprecated message and exits 2.
  - memory-fort retain prints a Phase 6 not-yet-implemented message and exits 2.
  - memory-fort schedule prints a Phase 6 not-yet-implemented message and exits 2.

- Sniffers implemented vs missing:
  - Implemented historical/default sniffers: Claude Code and Claude Desktop.
  - Default backfill and watch use only Claude Code and Claude Desktop sniffers.
  - Live capture hooks/config are implemented for Claude Code, Codex, and Antigravity.
  - MCP-only install exists for OpenClaw, Claude Desktop, and VS Code.
  - Hook-only or partial install exists for Hermes and Pi.
  - Missing historical sniffers: Codex, Antigravity, VS Code, Hermes, Pi, OpenClaw.
  - src/sniffers/types.ts advertises claude-code, antigravity, claude-desktop, vscode, and codex, but only Claude Code and Claude Desktop classes are present.
  - src/storage/paths.ts ToolName includes claude-code, codex, antigravity, and manual only.

- Retrieval stack completeness:
  - Lexical BM25 search is default and works without API keys.
  - Vector embeddings are supported through Voyage, OpenAI, and Ollama providers.
  - Voyage reranking is supported and optional.
  - Query intent classification, exact-match boosts, metadata scoring, graph expansion, spreading activation, RRF fusion, HyDE prompt emission, and corpus caches are implemented.
  - Embedding sidecars are guarded against zero, dim-3 stub, identical, and wrong-dimension vectors.
  - Retrieval degradation paths exist for missing embeddings and reranker failures.
  - Reranker abstraction is incomplete because reranking is Voyage-only.
  - HyDE/schema summaries and lint prompts lag the current schema surface.

- Dashboard completeness:
  - Local dashboard server and React UI are implemented under /memory.
  - Routes include Overview, Search, Wiki, Raw, Graph, Timeline, Activity, Inbox, Sessions, Crystals, Audit, Compile, Conflict Resolution, Maintenance, and Settings.
  - API surfaces include status, health, search, graph, graph-health, timeline, activity, sync-state, config, proposals, compile, conflicts, maintenance, wiki, raw, and log.
  - Graph visualization uses a Three.js "Galactic" scene on desktop and a read-only grouped fallback on mobile/touch-only.
  - Configuration patching, compile run, and proposal promotion/rejection are writable when the dashboard has write capability and same-origin/trusted-origin checks pass.
  - Conflict Resolution and Maintenance pages still expose disabled or incomplete action buttons.
  - Compile page contains some decorative/non-live preview elements noted by existing docs.

- Test coverage gaps:
  - Tests exist across build, capture, cli, compile, consolidate, curation, dashboard, dashboard-ui, eval, facts, graph, hooks, integration, llm, mcp, migration, privacy, release, retrieval, sniffers, storage, and sync.
  - The project policy warns that the full Vitest suite is noisy on the active WHITEDRAGON desktop.
  - Roadmap notes known flakes in longmemeval-integration.test.ts and install-vscode.test.ts.
  - No broad live-vault, multi-tool, end-to-end backfill coverage is evident for Codex, Antigravity, VS Code, Hermes, Pi, and OpenClaw sniffers because those sniffers are missing.
  - External benchmark evidence for Memory Fort itself is absent in README; LongMemEval entries are listed only for competitors or adjacent systems.

- Known technical debt (top 5):
  - Tool support matrix drift: README, install commands, live hooks, sniffers, watch, backfill, verify checks, and ToolName unions do not all agree.
  - Version and prompt/schema drift: package version, CLI version, plugin version, schema identity, lint prompt, HyDE summary, docs/ROADMAP, and docs/cli stubs have stale or inconsistent details.
  - Reranking is Voyage-only even though embeddings are provider-abstracted across lexical, Voyage, OpenAI, and Ollama.
  - Dashboard operator flows are incomplete for conflict resolution, maintenance actions, and some compile/graph preview surfaces.
  - Sync/retention/backup story is split between implemented git auto-push, hidden CLI stubs, VPS timers, and roadmap notes, making the public operational story harder to trust.

- Competitive gaps (top 5):
  - No managed cloud or polished multi-user memory service comparable to mem0-style hosted products.
  - No temporal fact graph/change-time reasoning positioned as strongly as Zep/Graphiti.
  - Not a full stateful agent runtime with agent identity, planning, and runtime memory comparable to Letta.
  - No multimodal ingestion pipeline comparable to systems that ingest documents, images, audio, or broader enterprise corpora.
  - No encryption-at-rest, privacy classes, ABAC, multi-human governance, or enterprise compliance surface yet.

- Roadmap items already queued:
  - README roadmap: OpenCode integration, optional SQLite-FTS derived index, and community integrations.
  - docs/ROADMAP Phase 1: trust signals, confidence vectors, lifecycle states, dashboard rendering, freshness/staleness verification.
  - docs/ROADMAP Phase 2: graph cohesion metrics, /api/graph-health, overview metric panel, graph.cohesion verify.
  - docs/ROADMAP Phase 3: entity registry, typed-edge proposing, edge audit/manual retyping, graph compaction, provenance backfill, validation workflow, retrieval intent classifier.
  - docs/ROADMAP Phase 4: richer memory kinds, procedures, query intent, grounding, debug logs, inbox, config hardening, scheduled compile, compile execute, memory feedback loop, relation edge alignment, auto-commit, dashboard split, compile correctness, narrative memory records.
  - docs/ROADMAP Phase 5 deferred: SQLite ledger, edge confidence calibration, multi-agent memory protocol, ABAC/Zero Trust/privacy classes, W3C PROV, webhooks, self-healing badges, embedding-based augmentation.
  - Operational follow-ups: fix known test flakes, sparse VPS embeddings, post-receive auto-deploy dashboard, document MEMORY_ROOT/MEMORY_ROLE, add verify remote syntax.
-->

# Prompt for GPT-5.5 Pro: Memory Fort v1.1 Cycle Planning

You are GPT-5.5 Pro acting as an external product, architecture, and research reviewer.

Your task is to design the next development cycle for an open-source project named Memory Fort.

Memory Fort is a local-first, cross-tool, persistent memory system for AI coding agents.

You must use the embedded project facts below as ground truth about the current implementation.

You must also perform fresh external research before forming conclusions.

Research date context: treat the current software and agent-memory landscape as 2026.

Do not assume the embedded competitive notes are current.

Verify competitor capabilities from current sources.

Use inline citations for every external factual claim.

Prefer primary sources:

- official docs
- official GitHub repositories
- changelogs
- product pages
- benchmark papers
- research papers
- protocol documentation
- authoritative SDK/API docs

Use secondary sources only when primary sources are unavailable.

Do not cite this prompt as an external source.

Do not ask me for repository access.

This prompt contains the repository audit facts you need.

Your output must be a v1.1 development cycle recommendation, not a generic market report.

The recommendation must be specific enough that an engineering team can convert it into issues.

## Required External Research Areas

Research the agent memory and local-first AI tooling landscape as of 2026.

Cover at least these areas:

1. Agent memory products and libraries.
2. MCP ecosystem and client/tool integration patterns.
3. Local-first AI tools and local data ownership patterns.
4. Multi-agent memory sharing and governance.
5. Embedding and reranking best practices for retrieval over personal/team memory.
6. Knowledge graph schemas for agent memory.
7. Hook/plugin integration support for OpenCode.
8. Hook/plugin integration support for Cursor.
9. Hook/plugin integration support for Windsurf.
10. Hook/plugin integration support for Zed.

When researching competitors, include at least:

1. mem0.
2. Zep.
3. Graphiti.
4. Letta.
5. Cognee.
6. LangMem.
7. OMEGA or the closest current local-first agent-memory peer if OMEGA is obsolete.
8. Any newer 2026 entrant that materially changes the recommendation.

## Required Final Output Shape

Return these sections in order:

1. Executive recommendation.
2. Current Memory Fort position.
3. External landscape findings with citations.
4. Competitive gap analysis.
5. Recommended v1.1 theme.
6. v1.1 must-haves, maximum 5.
7. v1.1 should-haves, maximum 5.
8. Deferred items.
9. Technical debt to pay first.
10. Success metrics.
11. Risks and mitigations.
12. Sequenced implementation plan.
13. Issue-ready work breakdown.
14. Research appendix with source links.

Do not exceed 5 must-have items.

Do not exceed 5 should-have items.

Each must-have must include:

- user-visible outcome
- technical scope
- why now
- acceptance criteria
- verification command or manual check
- risk level
- likely files/modules touched

Each should-have must include:

- user-visible outcome
- technical scope
- why it is not a must-have
- acceptance criteria

Each deferred item must include:

- reason for deferral
- trigger condition for revisiting

The issue-ready work breakdown must be concrete and independently grabbable.

Do not recommend a broad rewrite.

Do not recommend adding a database unless you prove the current Markdown-first model is blocking a v1.1 goal.

Do not recommend adding a dependency without explaining why it beats existing project utilities.

Do not propose cloud-first features that undermine local-first positioning.

## Product Thesis To Test

Memory Fort's current thesis:

Memory should be local, private, human-readable, Git-backed, Obsidian-compatible, and shared across AI tools.

The system should work offline by default with lexical retrieval.

Paid embeddings and rerankers should enhance quality but should not be required for basic use.

The distinctive wedge is not "another memory API."

The distinctive wedge is "one durable memory vault across many agent clients, inspectable and editable by humans."

Your job is to test whether this is still the right wedge for v1.1.

If the wedge should change, say so and justify it with evidence.

If the wedge is right, identify the smallest high-leverage v1.1 cycle that makes it credible.

## Embedded Repository Audit Facts

Use this section as the factual baseline for the current codebase.

### Project Identity

- Package name: memory-fort.
- package.json version: 0.1.2.
- CLI binary aliases: memory-fort and memory.
- package.json description: Cross-tool persistent memory for AI agents.
- Supported headline tools in README: Claude Code, Codex, Antigravity, Hermes, Pi, OpenClaw, Claude Desktop, and VS Code.
- The CLI version string in src/cli.ts is 0.1.0, which does not match package.json 0.1.2.
- The default vault root is MEMORY_ROOT or ~/.memory.
- The storage model is Markdown/YAML frontmatter under ~/.memory.
- The project is TypeScript and ESM.
- The UI is React 19 with TanStack Router/Query and Vite.
- The dashboard graph uses Three.js.
- The CLI uses Commander.
- The repository has Vitest tests.

### Core Value Proposition

- Local-first memory vault.
- Human-readable Markdown.
- YAML frontmatter schema.
- Obsidian-compatible wiki structure.
- Git-backed sync model.
- Cross-tool capture and retrieval.
- Lexical retrieval works without API keys.
- Optional embeddings improve retrieval when configured.
- Optional LLMs support compilation and synthesis flows.
- MCP server exposes retrieval to clients.
- Dashboard exposes local inspection and curation.

### README Quickstart

- npx memory-fort init initializes a vault.
- memory-fort grep searches captured raw memory and wiki pages.
- memory-fort dashboard starts the local dashboard.
- memory-fort install <tool> configures integrations.

### README Supported Install Commands

- memory-fort install claude-code: Claude Code full hooks plus plugin.
- memory-fort install codex: Codex desktop and CLI hooks plus MCP.
- memory-fort install antigravity: Google Antigravity/Gemini MCP plus live-capture plugin.
- memory-fort install hermes: Hermes YAML hooks plus MCP in ~/.hermes/config.yaml.
- memory-fort install pi: Pi coding agent YAML hooks in ~/.pi/config.yaml.
- memory-fort install openclaw: OpenClaw MCP server in ~/.openclaw/openclaw.json.
- memory-fort install claude-desktop: Claude Desktop MCP only.
- memory-fort install vscode: VS Code MCP only.

### README Retrieval Modes

- Lexical retrieval is the default and needs no API key.
- Voyage embeddings are supported.
- OpenAI embeddings are supported.
- Ollama local embeddings are supported.
- Voyage reranking is supported.

### README Comparison Table

| Capability | Memory Fort | mem0 | Zep / Graphiti | Letta | Cognee | LangMem | OMEGA |
|---|---|---|---|---|---|---|---|
| Storage | Markdown files | Cloud DB / OSS | Cloud only / Graphiti | PostgreSQL | SQLite + LanceDB | You choose | SQLite |
| Requires API key | No, lexical default | Yes | Yes | Yes for LLM | Yes for LLM | Yes for LLM | No |
| Self-hosted | Always | OSS option | Zep self-host dropped / Graphiti OSS | Free self-hosted | Local | OSS | Yes |
| Offline / air-gapped | Yes | No | No for hosted Zep | No by default | Yes with local LLM | No by default | Yes |
| Human-readable | Markdown + YAML | No | No | No | No | No | No |
| Obsidian-compatible | Native | No | No | No | No | No | No |
| Git-backed | Built in | No | No | No | No | No | No |
| Multi-tool hooks | Claimed 6 tools | No | No | No | No | No | No |
| Knowledge graph | Typed edges free | Pro only in README note | Graphiti | All tiers | All tiers | No | No |
| LongMemEval | Not reported | 49.0 percent in README note | 63.8 percent in README note | Not reported | Not reported | 59.8s p95 latency in README note | 95.4 percent in README note |
| Free tier | Unlimited local | Limited hosted tier | No hosted free tier in README note | Self-hosted | Self-hosted | OSS | Unlimited |
| TypeScript SDK | Native CLI + MCP | Yes | Yes | Partial | No, Python only | Partial | No |

Validate this table against current external sources.

Do not repeat the table uncritically if it is outdated.

### Implemented CLI Commands

Treat the following as implemented unless your reasoning needs to qualify their completeness:

- init
- install <platform>
- uninstall <platform>
- connect [client]
- disconnect [client]
- auto-heal <action>
- supervisor status
- sync-prompts
- grep <pattern>
- log <text>
- link-raw
- discover-threads
- compress
- compile
- reindex
- curate [page]
- compact-raw
- consolidate
- lint
- page <target>
- prune
- decay
- migrate-to-narrative
- relink-anchors
- provider list-embedders
- provider test-embedder
- provider reindex-embeddings
- provider rebless-embeddings
- provider list-llms
- provider test-llm
- provider test-classifier
- provider audit-summary
- provider audit-rotate
- import-agentmemory
- rewrite-imported-timestamps
- backfill
- backfill-source
- stats
- doctor
- verify
- watch
- tail-errors
- search <query>
- dashboard
- entity dedup
- entity merge <canonical>
- entity reject <canonical>
- entity aliases
- eval longmemeval
- eval download
- procedure propose
- procedure promote <slug>
- procedure reject <slug>
- thread propose
- thread promote <slug>
- thread reject <slug>
- eval-retrieval

### Hidden Stub Commands

These are hidden unless MEMORY_FORT_SHOW_STUBS=1:

- crystallize
- backup
- import-from-agentmemory
- retain
- schedule

Each prints a not-yet-implemented message and exits 2.

docs/cli.md still documents these stubs.

Do not plan v1.1 as if these already work.

### Install Integration Details

Claude Code:

- Installs a local Claude Code plugin under ~/.memory/claude-code-plugin.
- Writes plugin manifest and local marketplace catalog.
- Writes hook definitions for SessionStart, UserPromptSubmit, PostToolUse, PreCompact, and Stop.
- Writes hook script launchers copied from built dist hooks.
- Writes plugin-local .mcp.json with memory server command.
- Updates Claude Code settings enabledPlugins and extraKnownMarketplaces.
- Can uninstall plugin cache, marketplace, settings keys, plugin dir, and marketplace manifest.

Codex:

- Writes a sentinel block in ~/.codex/config.toml.
- Adds hooks for SessionStart startup/resume, UserPromptSubmit, PostToolUse, PreCompact, and Stop.
- Adds [mcp_servers.memory] with a Node stdio command for the MCP server.
- Uninstall strips the sentinel block and deletes the file if it becomes empty.

Antigravity:

- Writes ~/.gemini/antigravity/mcp_config.json with mcpServers.memory.
- Installs a plugin under plugins/memory when version support is detected or undetected.
- Hook names include session_start, pre_turn, post_turn, pre_tool_call, post_tool_call, tool_error_recovery, user_interaction_handling, context_compaction, and session_end.
- Generated hook scripts append raw Markdown and session-start context.
- Workspace/IDE/both surface selection currently shares the same MCP config.

Hermes:

- Writes a sentinel YAML block in ~/.hermes/config.yaml.
- Adds on_session_start and on_session_end hooks.
- Adds mcp_servers.memory.
- Integration appears partial relative to Claude Code and Codex.

Pi:

- Writes a sentinel YAML block in ~/.pi/config.yaml.
- Adds session_start and session_end command hooks.
- Pi MCP support is logged as varying and skipped for v1.
- Integration appears partial.

OpenClaw:

- Writes ~/.openclaw/openclaw.json.
- Adds mcpServers.memory.
- Preserves other MCP servers.
- No hooks in v1.

Claude Desktop:

- Writes Claude Desktop config with mcpServers.memory.
- Preserves other MCP servers.
- Repairs corrupted memory server entry.
- MCP only.

VS Code:

- Writes workspace .vscode/mcp.json or global VS Code mcp.json.
- Adds servers.memory with stdio command.
- Installs a bundled extension under .vscode/extensions/memory-fort.memory.
- MCP only from the README perspective.

### Capture Pipeline

- prompt-submit hook appends user prompts into raw session files.
- post-tool-use hook appends tool use blocks with input/output caps.
- pre-compact hook appends compaction markers.
- session-end hook appends session-end markers.
- session-start hook prints context to stdout for agent startup/resume.
- Raw files are stored as Markdown with frontmatter.
- Raw frontmatter includes type raw-session, title, created, updated, source, session, and cwd.
- Capture redacts likely secrets.
- Capture truncates long fields with configurable byte caps.
- Capture can schedule auto-push after stop/session end.
- Capture can trigger auto-link after tool use when configured.
- Tool detection currently maps CLAUDECODE=1 to claude-code and otherwise defaults to codex in shared hook code.
- Antigravity live capture uses generated plugin hooks rather than only the shared detect-tool path.

### Sniffers and Backfill

- Claude Code historical sniffer scans ~/.claude/projects/**/*.jsonl or MEMORY_CLAUDE_PROJECTS_DIR.
- Claude Desktop historical sniffer scans Claude Desktop config/log/session files.
- Claude Desktop sniffer supports watch() through fs.watch with debounce.
- The default backfill command uses only Claude Code and Claude Desktop sniffers.
- The default watch command uses only Claude Code and Claude Desktop sniffers.
- There is no implemented Codex historical sniffer.
- There is no implemented Antigravity historical sniffer.
- There is no implemented VS Code historical sniffer.
- There is no implemented Hermes historical sniffer.
- There is no implemented Pi historical sniffer.
- There is no implemented OpenClaw historical sniffer.
- The sniffer type union advertises more sources than the implemented classes.
- Backfill dedupes using normalized SHA-256 after redaction.
- Backfill writes raw/YYYY-MM-DD/<source>-<safe-session-id>.md.
- Backfill can optionally consolidate after import.
- Backfill writes audit logs under wiki/.audit.

### Retrieval Stack

- Corpus loading covers wiki, raw, and crystals.
- Search scopes are wiki, raw, crystals, and all.
- Wiki archive and dot dirs are skipped.
- Documents include cognitive type, lifecycle, confidence vector, source, relations, and raw identity metadata.
- BM25 lexical retrieval is implemented.
- Exact match boosts are implemented.
- Vector cosine retrieval is implemented when embeddings exist.
- Graph expansion is implemented.
- Spreading activation is implemented.
- Metadata scoring is implemented.
- Query intent classification is implemented.
- Intent-aware weighting is implemented.
- Reciprocal rank fusion is implemented.
- Voyage reranking is implemented.
- HyDE prompt emission is implemented for short/abstract or zero-BM25 queries.
- HyDE expansion can be supplied by caller.
- Search returns warnings, timings, degradation flags, corpus errors, and cache stats.
- Dashboard search currently passes refreshEmbeddings false.
- Embedding refresh defaults to Voyage model voyage-4-large and dimension 2048.
- Voyage rerank default model is rerank-2.5.
- OpenAI embedding defaults to text-embedding-3-small.
- Ollama embedding defaults to http://localhost:11434 and nomic-embed-text.
- Embedding store sidecars are JSONL files under embeddings/.
- Embedding store refuses zero, unit-stub, wrong-dimension, and degenerate vectors.
- Embedding health verifies absent/stub/identical/zero/wrong-dimension sidecars.
- Reranking is Voyage-only.
- HyDE schema reminder is templated but can lag the full schema.

### Knowledge Graph and Schema

- templates/schema.md says schema_version 1.4.
- Current audited schema has 13 top-level sections.
- It covers identity, entity types, required frontmatter, confidence vector, lifecycle, cognitive types, prospective memory, narrative threads, auto-thread proposing, auto-promote/inbox, edge taxonomy, quality, privacy filtering, ingest workflow, lint rules, anti-patterns, storage behavior, user identity, and versioning.
- Entity/page types include projects, issues, people, decisions, lessons, prospective, procedures, threads, references, tools, crystal, and raw-session.
- Relation edges support typed frontmatter relations.
- Edge metadata can include target, confidence, source, valid_from, valid_to, superseded_by, and related provenance.
- Graph edge weights include high-confidence semantic edges and lower-confidence mention/derived/wikilink edges.
- Metadata scoring uses status, lifecycle, validation confidence, source confidence, and recency.
- Rich relation parsing filters superseded and expired edges.
- Edge grammar checks are advisory except broken frontmatter/relations can block lint.
- There is known drift between schema, lint prompt, HyDE summaries, and tool identity lists.

### Curation and Compile

- memory compile assembles a prompt from runtime template, schema, index, log, raw tails, and existing page context.
- Compile supports plan mode and execute mode.
- Compile tracks per-file consumed watermarks.
- Compile supports drain loops across multiple passes.
- Execute mode sends prompts to a configured LLM.
- Execute mode parses fenced compile-ops JSON.
- Operation kinds include write_page, append_page, rewrite_page, update_index, and append_log.
- Executor normalizes page paths and rejects unsafe paths.
- Low-confidence operations are staged under wiki/compile-proposed.
- Existing durable knowledge pages prefer rewrite_page.
- Prior versions are archived under wiki/.history.
- Index rebuild is automated after execution.
- Watermarks advance only after successful non-plan execution.
- Raw fact compression exists.
- Fact consolidation groups compressed facts by concept.
- Narrative synthesis rejects headings, lists, code fences, and tables in narrative bodies.
- Narrative synthesis stages drafts when contradiction or wikilink-loss thresholds trip.

### Dashboard

- Dashboard is served at /memory.
- API includes /healthz.
- API includes /api/status.
- API includes /api/health.
- API includes /api/search.
- API includes /api/graph.
- API includes /api/graph-health.
- API includes /api/sync-state.
- API includes /api/config.
- API includes /api/providers.
- API includes /api/proposed/*.
- API includes /api/compile/*.
- API includes /api/conflicts.
- API includes /api/maintenance/scan.
- API includes /api/wiki.
- API includes /api/raw.
- API includes /api/log.
- Mutating config writes require write capability and same-origin/trusted-origin checks.
- Compile run endpoint can execute or produce prompt artifacts.
- Proposal promote/reject endpoints exist.
- UI routes include Overview, Search, Wiki, Raw, Graph, Timeline, Activity, Inbox, Sessions, Crystals, Audit, Compile, Conflict Resolution, Maintenance, and Settings.
- Graph page uses a desktop Three.js galactic scene.
- Graph page has mobile/touch fallback as grouped node index.
- Conflict Resolution page has disabled conflict action buttons.
- Maintenance page has disabled action buttons.
- Compile page has some preview/log elements that may not be live operational data.

### Verify and Health

- memory verify runs role-aware health checks.
- Roles include operator and server.
- Checks include vault read-write, config validity, dashboard status, search pipeline, episodic relations coverage, freshness/staleness, prospective overdue, graph cohesion, embedding health, intent classifier health, source field, atomic write retries, compile recent, compile execute health, prompt drift, curation content loss, auto-push errors, uncommitted vault, git remote, and client-specific checks.
- Client checks exist for Claude Code, Codex, Antigravity, VS Code, and Claude Desktop.
- Verify scheduling supports Windows PowerShell task, Linux systemd, and Darwin launchd.
- The project policy says full Vitest is noisy locally on WHITEDRAGON.

### Sync and Operations

- Sync is git-based.
- Default sync remote comes from config.sync.remote_name or vps.
- Default sync branch is main.
- Sync detects clean, dirty, local-ahead, remote-ahead, divergent, and conflicted states.
- Pull uses rebase semantics.
- Push has retry/conflict handling.
- Sync state is stored in .sync-state.json.
- Auto-commit raw files commits only raw paths and system-managed paths.
- Auto-commit raw files secret-scans before committing.
- Auto-push uses a detached Node worker and debounce.
- MEMORY_AUTO_PUSH=0 disables auto-push.
- Retain/backup/schedule CLI commands remain hidden stubs.
- VPS backup timer is mentioned in docs as separate from local CLI backup stub.

### Templates and Config

- templates/config.yaml defaults to lexical embedder.
- Retention defaults include raw_window_days 90 and archive_before_delete true.
- Capture caps default to 8192 bytes for input and output.
- Compression defaults include 48k input, 48k chunk threshold, 8 max chunks, and 100k max call tokens.
- auto_link defaults enabled true with embedding threshold 0.65 and lexical threshold 0.55.
- config.yaml contains graph edge weight examples.
- config.yaml supports dashboard trusted_origins.
- config.yaml supports LLM config.
- Provider secrets are environment-variable based.
- loadMemoryConfig logs parse warnings and returns empty config on parse failure.
- verify has a config.valid check.
- templates/prompts/compile.md is current as of 2026-05-31 curate-refinement.
- templates/prompts/lint.md is stale relative to newer entity types and relation taxonomy.
- templates/prompts/hyde.md is current as of 2026-05-31 curate-refinement but depends on schema_summary injection that can lag.

### Tests

- Test directories include build.
- Test directories include capture.
- Test directories include cli.
- Test directories include compile.
- Test directories include consolidate.
- Test directories include curation.
- Test directories include dashboard.
- Test directories include dashboard-ui.
- Test directories include eval.
- Test directories include facts.
- Test directories include fixtures.
- Test directories include graph.
- Test directories include hooks.
- Test directories include integration.
- Test directories include llm.
- Test directories include mcp.
- Test directories include migration.
- Test directories include privacy.
- Test directories include release.
- Test directories include retrieval.
- Test directories include sniffers.
- Test directories include storage.
- Test directories include sync.
- A grep audit found test/cli/stubs.test.ts explicitly covering hidden stubs.
- A grep audit found test/cli/commands/grep.test.ts conditionally skips a ripgrep-dependent test when ripgrep is unavailable.
- A grep audit found no broad implemented test coverage for missing sniffers because those sniffers are not implemented.
- Roadmap notes known flakes in longmemeval-integration.test.ts and install-vscode.test.ts.

### README Roadmap

- OpenCode integration.
- Optional SQLite-FTS derived index.
- Community integrations.

### docs/ROADMAP Items

- Phase 0 operational stability and episodic consolidation is marked complete.
- Phase 1 trust signals foundation is marked in progress.
- Phase 2 observability graph cohesion metrics is marked drafting next.
- Phase 3 targeted quality fixes are pending Phase 2 evidence.
- Phase 4 richer memory kinds are planned, but many listed subitems appear shipped in code.
- Phase 5 deferred items include SQLite ledger, edge confidence calibration, multi-agent memory protocol, ABAC/Zero Trust/privacy classes, W3C PROV, webhooks, badge self-healing, and embedding-based augmentation.
- Operational follow-ups include fixing two test flakes, sparse VPS embeddings, post-receive auto-deploy dashboard, documenting MEMORY_ROOT and MEMORY_ROLE, and adding memory verify remote syntax.
- docs/ROADMAP is likely stale relative to code in several places.

### Top 5 Technical Debt Items To Consider

1. Tool support matrix drift:
   - README claims broad multi-tool support.
   - Installers support eight named surfaces.
   - Live hooks are strongest for Claude Code, Codex, and Antigravity.
   - Historical sniffers/backfill/watch exist only for Claude Code and Claude Desktop.
   - Verify checks mention tools that do not have sniffers.
   - ToolName unions and raw identity parsing do not cover every supported tool.

2. Version, schema, and prompt drift:
   - package.json is 0.1.2 while CLI reports 0.1.0.
   - Some plugin metadata is 0.1.0.
   - docs/ROADMAP has phases that appear partly shipped.
   - docs/cli still documents hidden stubs.
   - schema identity lists fewer tools than README.
   - lint and HyDE prompt summaries lag current entity/relation taxonomy.

3. Retrieval provider asymmetry:
   - Embeddings are provider-abstracted across lexical, Voyage, OpenAI, and Ollama.
   - Reranking is Voyage-only.
   - Local-first users cannot get local rerank quality except by disabling rerank.

4. Dashboard operator workflow incompleteness:
   - Conflict Resolution actions are disabled.
   - Maintenance actions are disabled.
   - Compile page preview/log elements may not be live operational state.
   - Graph mobile fallback is read-only.

5. Operations story split:
   - Git sync and auto-push are implemented.
   - Retain, backup, and schedule remain hidden CLI stubs.
   - VPS backup timer is separate.
   - The public story for backup, retention, scheduling, and remote verification is fragmented.

### Top 5 Competitive Gaps To Validate

1. Managed/cloud UX:
   - Memory Fort is local-first and unlimited locally.
   - It likely lacks polished hosted onboarding, team administration, and managed API workflows.

2. Temporal graph sophistication:
   - Memory Fort has typed temporal edges and lifecycle states.
   - It may not match Zep/Graphiti-style temporal fact extraction and change-time reasoning.

3. Full agent runtime:
   - Memory Fort is a memory vault plus integrations.
   - It is not a stateful agent runtime like Letta.

4. Multimodal/corpus ingestion:
   - Memory Fort focuses on agent-session raw Markdown, wiki pages, and imports.
   - It lacks clear image/audio/PDF/document ingestion pipelines.

5. Enterprise governance:
   - Memory Fort has redaction and local storage.
   - It lacks explicit encryption-at-rest, ABAC, privacy classes, multi-human governance, and compliance features.

## Analysis Instructions

Start by deciding whether v1.1 should be:

- integration credibility cycle
- retrieval quality cycle
- dashboard operator cycle
- sync/backup/operations cycle
- competitive benchmark cycle
- some combined narrow cycle

Do not choose more than one primary theme.

You may include secondary should-haves, but the theme must be crisp.

Make the plan small enough for one focused development cycle.

Prioritize work that improves the project's public claim credibility.

Be skeptical of roadmap items that are already partly shipped but not wired end to end.

Be skeptical of features that make demos look better without improving trust.

Prefer changes that make README claims truthful and verifiable.

Prefer changes that create durable regression tests.

Prefer changes that strengthen local-first/offline behavior.

Prefer changes that reduce support burden.

Prefer changes that produce externally legible proof, such as:

- install verification matrix
- real command demos
- health checks
- benchmark reports
- dashboard evidence
- integration docs

## Specific Questions To Answer

1. What is Memory Fort's strongest defensible niche in 2026?
2. Is "local, Markdown, Git, Obsidian, multi-tool" still differentiated?
3. Which README claim is most at risk of being perceived as overclaiming?
4. Which v1.1 investment would most improve trust in the project?
5. Should OpenCode be the next integration, or should existing integrations be hardened first?
6. Should Cursor/Windsurf/Zed be targeted in v1.1, deferred, or supported only through MCP docs?
7. Is SQLite-FTS worth doing now, or should retrieval validation come first?
8. Is a local reranker worth doing now, or should provider asymmetry wait?
9. Is the dashboard more important than backfill/watch coverage for v1.1?
10. What evidence should be published with v1.1?

## Output Constraints

Be direct.

Be opinionated.

Ground every recommendation in either embedded audit evidence or cited external research.

When you use embedded audit evidence, say "repo audit indicates" or "current implementation indicates."

When you use external evidence, cite it inline.

Do not cite sources in a separate-only bibliography without inline citation.

Include a concise final "recommended next issue list" with titles.

The issue list should be ready to paste into an issue tracker.

Do not include generic tasks like "improve docs" unless they name the exact claim or document to fix.

Do not propose more than 10 total issues for the v1.1 cycle.

Separate "must-have" issues from "should-have" issues.

## Evaluation Rubric

Your answer is good if:

- It identifies a single v1.1 theme.
- It limits must-haves to five or fewer.
- It limits should-haves to five or fewer.
- It updates Memory Fort's competitive position with current research.
- It explicitly accounts for current command implementation status.
- It explicitly accounts for supported tool integration type.
- It explicitly accounts for current roadmap drift.
- It identifies which README claims need tightening or proof.
- It gives testable acceptance criteria.
- It does not chase every possible feature.
- It respects the local-first product thesis.
- It tells the team what not to do in v1.1.

Your answer is bad if:

- It recommends a broad rewrite.
- It ignores the missing sniffers.
- It treats hidden stubs as implemented.
- It recommends cloud-first strategy without a strong local-first-compatible reason.
- It recommends SQLite before proving Markdown/BM25 is a bottleneck.
- It recommends adding many integrations while existing integration proof is weak.
- It lacks citations for external claims.
- It fails to produce issue-ready work.

Now perform the external research, evaluate the embedded repo audit, and produce the v1.1 development cycle recommendation.
