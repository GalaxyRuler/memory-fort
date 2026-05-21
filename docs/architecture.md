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
| **Antigravity desktop** | ✗ — Antigravity has no hook system (verified May 2026) | ✓ — `~/.gemini/antigravity/mcp_config.json` |

A single source of truth — `~/.memory/claude-code-plugin/scripts/` — holds the compiled hook scripts. Both Claude Code (via `${CLAUDE_PLUGIN_ROOT}` substitution) and Codex (via absolute paths in `config.toml`) point at this shared directory. Antigravity uses the MCP server only — no scripts referenced for hooks since none fire.

## What runs when

There is no daemon. Components are spawned by host tools and die with them:

```
SessionStart → session-start.mjs → reads schema.md + index.md + recent log.md, emits to stdout (Claude Code injects into agent context)

UserPromptSubmit → prompt-submit.mjs → appends ## Prompt block to raw/<date>/<tool>-<session>.md

PostToolUse → post-tool-use.mjs → appends ## ToolUse block

PreCompact → pre-compact.mjs → appends CompactionMarker

Stop / SessionEnd → session-end.mjs → appends SessionEnd marker

MCP active tools (callable by the LLM in any host session):
  memory.log_observation(text, tags?, confidence?, source?) — write
  memory.read_page(path) — read wiki page
  memory.list_pages(type?, tag?, status?) — discover
```

Each hook script is a one-shot Node.js process that reads stdin (the hook payload as JSON), appends to a markdown file, exits 0. Errors go to `~/.memory/errors.log` — see [troubleshooting.md](troubleshooting.md).

The MCP server is a stateless stdio process spawned by each host on session start. It registers three tools, services requests against `~/.memory/`, and exits when the host closes.

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

## Related docs

- [cli.md](cli.md) — CLI command reference
- [install-claude-code.md](install-claude-code.md) — Claude Code install walkthrough
- [install-codex.md](install-codex.md) — Codex install walkthrough
- [install-antigravity.md](install-antigravity.md) — Antigravity install walkthrough
- [troubleshooting.md](troubleshooting.md) — failure modes + diagnosis
- [follow-ups.md](follow-ups.md) — known issues queued for later phases
- [../superpowers/specs/2026-05-20-cross-tool-memory-system-design.md](superpowers/specs/2026-05-20-cross-tool-memory-system-design.md) — full design spec
