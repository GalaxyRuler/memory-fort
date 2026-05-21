# CLI reference

`memory <subcommand> [options]` — single binary at `dist/cli.mjs`, installed as `memory` on PATH via npm-link or by running `node dist/cli.mjs` directly.

## Phase 1 commands (implemented)

### `memory init [--reset]`

Initialize `~/.memory/` with directory structure, schema template, baseline files, and git repository. Idempotent — re-running preserves existing files.

| Flag | Description |
|---|---|
| `--reset` | Destructive: archives existing `~/.memory/` to a sibling `~/.memory.reset-<timestamp>/` before re-init |

**Exit codes:** 0 success, 1 IO error.

**Example:**
```bash
memory init
# → creates ~/.memory/ with schema.md, index.md, log.md, config.yaml, .gitignore, .git/
```

---

### `memory install <platform>`

Wire hooks (where available) + MCP for one of the three platforms.

| Platform | What it does |
|---|---|
| `claude-code` | Writes plugin manifest + hooks.json + plugin-scoped `.mcp.json` to `~/.memory/claude-code-plugin/`. Migrates legacy `~/.claude/.mcp.json` if present. |
| `codex` | Appends sentinel-marker block to `~/.codex/config.toml` with `[[hooks.*]]` and `[mcp_servers.memory]`. Covers both Codex desktop and CLI. |
| `antigravity` | Merges memory MCP entry into `~/.gemini/antigravity/mcp_config.json`. No hooks (Antigravity has no hook system). |

**Exit codes:** 0 success, 1 IO error, 2 unknown platform.

**Examples:**
```bash
memory install claude-code
memory install codex
memory install antigravity
```

---

### `memory grep <pattern> [--scope raw|wiki|both] [-C <n>]`

Tier-1 retrieval via ripgrep wrapper. Searches markdown files under `~/.memory/raw/` and/or `~/.memory/wiki/`.

| Flag | Default | Description |
|---|---|---|
| `--scope` | `both` | `raw`, `wiki`, or `both` |
| `-C, --context <n>` | `2` | Lines of context |

**Exit codes:** 0 matches found, 1 no matches, 2 error or ripgrep missing.

**Example:**
```bash
memory grep "stale ports"
memory grep "windows" --scope wiki -C 5
```

---

### `memory log "<text>" [--tag X --tag Y] [--confidence 0..1]`

Append a manual observation to today's raw file (`source: manual`). CLI counterpart to the MCP `log_observation` tool — usable from any terminal without an open agent session.

| Flag | Description |
|---|---|
| `--tag <tag>` | Tag (repeatable); each `--tag X` appends to the array |
| `--confidence <n>` | 0..1 (0 = uncertain, 1 = certain) |

**Exit codes:** 0 appended, 1 IO error, 2 bad input (empty text, invalid confidence).

**Example:**
```bash
memory log "Reminder: Voyage 3.5 is $0.06/M, not $0.18/M"
memory log "F3 closed" --tag windows --tag mcp --confidence 0.95
```

---

### `memory stats`

State summary: file counts per area, last activity, install status per platform, errors.log size, git state.

**Exit codes:** 0 always (read-only).

---

### `memory doctor`

Structural sanity check — verifies directories exist, baseline files present, plugin manifests readable, errors.log size. Exits non-zero on failures so it can gate scripts.

**Exit codes:** 0 all checks pass, 1 one or more failed.

---

### `memory tail-errors`

Live `tail -f` on `~/.memory/errors.log`. Ctrl+C to exit.

**Exit codes:** 0 normal exit (Ctrl+C), 1 IO error.

---

## Phase 2-6 commands (stubs)

Each prints a "not yet implemented in Phase 1" message and exits 2. The CLI surface is locked; later phases fill in implementations without changing the surface.

| Stub | Phase |
|---|---|
| `memory search` | 3 — Hybrid retrieval (BM25 + voyage-4-large embeddings + Voyage Rerank 2.5 + graph traversal) |
| `memory compile` | 2 — Compile raw observations into curated wiki pages |
| `memory lint` | 2 — Check wiki for contradictions, orphans, stale claims, broken `[[wikilinks]]` |
| `memory crystallize` | 4 — Distill a completed thread into a long-form digest |
| `memory backup` | 6 — git commit + push memory state to remote |
| `memory page` | 2 — Pretty-print a wiki page with resolved relations |
| `memory import-from-agentmemory` | 5 — One-shot migration from GalaxyRuler/agentmemory's binary state store |
| `memory retain` | 6 — Run retention policy (archive expired raws, prune embeddings) |
| `memory schedule` | 6 — Install OS-level scheduled tasks (Windows Task Scheduler / cron / launchd) |

## Common patterns

**Verify install after `memory install <platform>`:**
```bash
memory doctor
memory stats
```

**Capture a thought from a terminal mid-day:**
```bash
memory log "Tried voyage-3.5 vs voyage-4-large — quality delta negligible at our scale"
```

**Search for something across all session data:**
```bash
memory grep "windows stale port" -C 5
```

**Watch hooks for breakage:**
```bash
memory tail-errors    # in a separate terminal while running Claude Code / Codex
```

## Environment variables

| Variable | Purpose |
|---|---|
| `MEMORY_ROOT` | Override `~/.memory/` location. Used by tests to redirect to temp dirs; can be used to run multiple memory roots side by side. |
| `MEMORY_CLAUDE_DIR` | Override `~/.claude/` location for `memory install claude-code` (test/safety) |
| `MEMORY_CODEX_DIR` | Override `~/.codex/` location for `memory install codex` |
| `MEMORY_ANTIGRAVITY_DIR` | Override `~/.gemini/antigravity/` location for `memory install antigravity` |
| `MEMORY_REPO_DIR` | Override the source repo root for `memory install` (where compiled hook scripts live) |
| `MEMORY_SDK_CHILD` / `AGENTMEMORY_SDK_CHILD` | Set to `1` to mark a hook invocation as SDK-internal — hooks early-exit without writing, preventing recursive observation loops |
