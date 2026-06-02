# Architecture

A single file-system-backed memory directory shared by **Claude Code**, **Codex** (desktop + CLI), and **Google Antigravity**. No daemon, no ports, no database. Storage is plain markdown + small JSON sidecars under `~/.memory/`. Git is the durable backup.

## The three layers

Following the Karpathy LLM Wiki pattern (April 2026) with the LLM-Wiki-v2 extensions (agentmemory lessons):

| Layer | What it is | Who writes |
|---|---|---|
| **Raw observations** (`~/.memory/raw/<date>/<tool>-<session>.md`) | Session-by-session firehose: every prompt, every tool call, with frontmatter | Hooks (passive) + MCP `log_observation` (active) |
| **Wiki** (`~/.memory/wiki/<category>/<slug>.md`) | Curated entity pages with typed frontmatter relations — projects, people, decisions, lessons, references, tools | Compile pass (Phase 2+) reads raw, writes wiki |
| **Crystals** (`~/.memory/crystals/<date>-<slug>.md`) | Long-form distillations of completed work threads | Crystallize pass (Phase 4+) — explicit, intentional |

The schema is defined by `~/.memory/schema.md` (the controlling document) — what entity types exist, what edge types relate them, what the LLM should and shouldn't do during ingest/compile/lint/crystallize.

## How the three platforms integrate

| Platform | Hooks (passive) | MCP (active) |
|---|---|---|
| **Claude Code** | ✓ — plugin at `~/.memory/claude-code-plugin/` with `hooks/hooks.json` referencing `${CLAUDE_PLUGIN_ROOT}/scripts/*.mjs` | ✓ — `.mcp.json` inside the plugin dir; Claude Code auto-loads on plugin activation |
| **Codex** (desktop + CLI) | ✓ — sentinel-marker block in `~/.codex/config.toml` with `[[hooks.<Event>]]` arrays referencing absolute script paths | ✓ — `[mcp_servers.memory]` section in the same `config.toml` |
| **Antigravity desktop** | ✓ — live-capture plugin at `~/.gemini/antigravity/plugins/memory/` | ✓ — `~/.gemini/antigravity/mcp_config.json` |

A single source of truth — `~/.memory/claude-code-plugin/scripts/` — holds the compiled Claude Code and Codex hook scripts. Claude Code uses `${CLAUDE_PLUGIN_ROOT}` substitution, and Codex uses absolute paths in `config.toml`. Antigravity uses its own plugin hook scripts under `~/.gemini/antigravity/plugins/memory/hooks/`, plus the same shared MCP server for active memory tools.

## What runs when

There is no daemon. Components are spawned by host tools and die with them:

```
SessionStart → session-start.mjs → resolves the hook cwd to a `wiki/projects/<slug>.md` page when possible, emits that project body + 1-hop related summaries, then schema.md + index.md + recent log.md to stdout (Claude Code and Codex inject stdout into agent context)

UserPromptSubmit → prompt-submit.mjs → appends ## Prompt block to raw/<date>/<tool>-<session>.md

PostToolUse → post-tool-use.mjs → appends ## ToolUse block

PreCompact → pre-compact.mjs → appends CompactionMarker

Stop / SessionEnd → session-end.mjs → appends SessionEnd marker

MCP active tools (callable by the LLM in any host session):
  memory.log_observation(text, tags?, confidence?, source?) — write
  memory.read_page(path) — read wiki page
  memory.list_pages(type?, tag?, status?) — discover
  memory.search(query, scope?, k?, min_score?, no_rerank?, hyde_expansion?) — query the VPS search backend
```

The cwd-aware SessionStart path is deterministic and bounded: project pages can declare `repo:` or `repo_paths:` frontmatter for authoritative matches, otherwise the hook falls back to exact project-slug path segments such as `C:\CodexProjects\memory-system`. Unknown cwd values keep the legacy schema/index/log output. The current project body is the only full page injected; related pages are limited to titles and index summaries.

Each hook script is a one-shot Node.js process that reads stdin (the hook payload as JSON), appends to a markdown file, exits 0. Errors go to `~/.memory/errors.log` — see [troubleshooting.md](troubleshooting.md).

The MCP server is a stateless stdio process spawned by each host on session start. It registers four tools, services local read/write requests against `~/.memory/`, and exits when the host closes. The `memory.search` tool is intentionally a thin client of the Tailscale-protected VPS dashboard endpoint (`/memory/api/search`): local creator machines do not run retrieval or hold Voyage credentials, but Claude Code, Codex, and Antigravity can still ask the shared backend for ranked results with snippets and provenance.

## Curation pipeline

Ingest is passive and automated: hooks and MCP calls append markdown firehose data under `raw/`. Curation is deliberate and LLM-assisted: the user runs commands that assemble context, then the active agent session edits or inspects `wiki/`.

`compile` is the bridge from accumulated observations to curated wiki pages. The LLM reads raw observations and proposes updates to `wiki/`. The cross-session signal threshold — usually 3 or more raw mentions before creating a new page — is enforced by instructions in the prompt template, not by `memory compile` itself. The CLI reads `schema.md`, `index.md`, recent `log.md` lines, and raw files newer than the latest compile cutoff, substitutes them into `prompts/compile.md`, and prints the result.

`lint` checks structural integrity. Programmatic mode (`--checks-only`) catches mechanical issues: invalid frontmatter, broken `[[wikilinks]]`, broken `relations:` targets, orphan pages, stale active pages, and low-confidence drafts. LLM mode adds judgment: distinguishing real issues from intentional edge cases, suggesting concrete next steps, and prioritizing what to fix first.

`page` is read-only inspection for one wiki page. It resolves outbound edges from `relations:` and discovers inbound edges by reverse-scanning other pages. Use it to verify that a relation points to a real page and to see which pages cite the one being inspected.

```
raw/*.md  -> compile (LLM)  -> wiki/*.md  -> lint (LLM or --checks-only)  -> page (inspect)
```

Most curation commands are orchestrators: the CLI assembles context and performs deterministic filesystem reads; the LLM does judgment in the user's active agent session. **Exception (Phase 4.3+/4.4):** the autonomous consumers — `thread/procedure propose`, the query-intent classifier, and `compile --execute` — call the configured LLM provider directly (audited via `chatWithAudit`, gated by `MEMORY_LLM_DISABLED`). The orchestrator-only model still holds for `compile` artifact mode, `lint`, and `page`.

## Why no daemon

Every reliability failure documented in the `codex/windows-codex-desktop-stability` session of agentmemory (the predecessor) required a persistent daemon with bound ports: stale dead-PID sockets, port management, `cwd`-coupled data directories, supervisor lifecycle, hardcoded port config files. None of those failure modes can exist here because the components that fail don't exist. The MCP server uses stdio — no ports. It lives only inside a session — no orphan processes between sessions.

## Storage growth

| Component | Growth rate | Bounded? |
|---|---|---|
| `raw/` | ~400 KB/session × ~5-10 sessions/day = 2-4 MB/day | No — retention policy archives raw files older than 90 days |
| `wiki/` | Bounded by entities the user has (~1000 pages ≈ 5 MB) | Yes — slow growth, mostly manual |
| `crystals/` | Bounded by intentional creation (~100/year ≈ 2 MB/year) | Yes |
| `embeddings/` | 4 KB/page × wiki page count | Yes — auto-prunes |

Heavy-use steady state with default 90-day retention: ~1.5 GB total. Light use: ~200 MB. Configurable in `~/.memory/config.yaml`.

## Where things break

Errors are loud — every hook script catches its own failures and appends a timestamped entry to `~/.memory/errors.log`. Run `memory tail-errors` to watch live. Run `memory doctor` for a structural sanity check.

See [troubleshooting.md](troubleshooting.md) for the top failure modes per platform with diagnosis steps.

## Bundling strategy

The retrieval and dashboard code in `src/` gets bundled to `dist/` via tsdown, with rolldown under the hood. Modules use different bundling strategies depending on their runtime constraints:

| Module | Strategy | Reason |
|---|---|---|
| `dist/retrieval/voyage-client.mjs` | External SDK using `createRequire` | `voyageai@0.2.1` has an ESM entry that uses unsupported directory imports under Node 22; the CommonJS export loads reliably |
| `dist/retrieval/corpus.mjs`, `dist/retrieval/metadata-score.mjs` | Self-contained parsers, no `gray-matter` or `js-yaml` | Keeps retrieval bundles small and avoids dependency-resolution surprises in VPS/runtime smoke paths |
| `dist/dashboard/server.mjs` | Bundles app code; `voyageai` remains external | Same SDK constraint as `voyage-client`; the dashboard process loads the SDK from runtime `node_modules` |
| `dist/cli.mjs` | Bundles app code; search CLI uses Node built-ins such as `fetch` | Local creator machines do not need Voyage credentials or extra runtime dependencies for CLI search |
| `dist/hooks/*` | Bundles app code for cold-start `node` invocations | Hook scripts and the detached `auto-push-worker` need self-sufficient bundles when spawned by host tools |

When the dashboard runs on the VPS, `voyageai` must be available under `/root/memory-system/services/node_modules/voyageai`. The `memory install-vps` command installs that runtime dependency automatically. Rolldown's internal `PLUGIN_TIMINGS` diagnostics are silenced with `checks: { pluginTimings: false }` in `tsdown.config.ts`.

## Related docs

- [cli.md](cli.md) — CLI command reference
- [curation-workflow.md](curation-workflow.md) — compile/lint/page operating loop
- [install-claude-code.md](install-claude-code.md) — Claude Code install walkthrough
- [install-codex.md](install-codex.md) — Codex install walkthrough
- [install-antigravity.md](install-antigravity.md) — Antigravity install walkthrough
- [troubleshooting.md](troubleshooting.md) — failure modes + diagnosis
- [follow-ups.md](follow-ups.md) — known issues queued for later phases
- [../superpowers/specs/2026-05-20-cross-tool-memory-system-design.md](superpowers/specs/2026-05-20-cross-tool-memory-system-design.md) — full design spec
