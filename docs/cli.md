# CLI reference

`memory <subcommand> [options]` — single binary at `dist/cli.mjs`, installed as `memory` on PATH via npm-link or by running `node dist/cli.mjs` directly.

## search

`memory search <query> [--scope wiki|raw|crystals|all] [--k <n>] [--min-score <n>] [--no-rerank] [--json] [--vps-url <url>]` queries the VPS dashboard `/api/search` endpoint over Tailscale and prints ranked memory results. Use `--json` to emit the raw API response for debugging or scripts; otherwise the CLI prints the query, result count, latency, warnings, and a short snippet per result. This command does not run retrieval locally and does not need local Voyage credentials.

---

## compile

**Synopsis:**
```bash
memory compile [--since <iso>] [--per-file-max-bytes <bytes>] [--total-max-bytes <bytes>] [-o, --output <path>]
```

**Description:**
Assemble an LLM prompt by substituting recent raw observations, schema, index, and log context into `~/.memory/prompts/compile.md`. This command is an orchestrator: the LLM in your active agent session reads the printed prompt and performs the actual wiki edits. `memory compile` never calls an LLM and never writes to `wiki/`.

**Options:**

| Flag | Default | Description |
|---|---|---|
| `--since <iso>` | Latest `compile` entry in `log.md`, or epoch if none | Only include raw files modified at or after this timestamp |
| `--per-file-max-bytes <bytes>` | `10000` | Maximum content read from each raw file |
| `--total-max-bytes <bytes>` | `200000` | Maximum raw content folded into the prompt across all files |
| `-o, --output <path>` | stdout only | Also write the assembled prompt to a file |

**Examples:**
```bash
node dist/cli.mjs compile
node dist/cli.mjs compile --output compile-prompt.md
```

**Exit codes:** 0 success, 1 error. If `~/.memory/prompts/compile.md` is missing, run `memory init` first.

---

## lint

**Synopsis:**
```bash
memory lint [--checks-only] [--stale-days <n>]
```

**Description:**
Run the wiki lint workflow in one of two modes. By default, `memory lint` assembles an LLM prompt using the same orchestrator pattern as `compile`: the CLI prints context, and the user's active agent session does the judgment work. With `--checks-only`, the CLI skips the LLM and runs programmatic checks directly: frontmatter validity, broken `[[wikilinks]]`, broken `relations:` targets, orphan pages, stale active pages, and low-confidence drafts. `--checks-only` exits 1 if any frontmatter or broken-relation issues exist because those are data-integrity blockers; other categories are advisory and exit 0.

**Options:**

| Flag | Default | Description |
|---|---|---|
| `--checks-only` | off | Run programmatic checks and print a structured text report |
| `--stale-days <n>` | `180` | Stale-page threshold used by `--checks-only` |

**Examples:**
```bash
node dist/cli.mjs lint
node dist/cli.mjs lint --checks-only
```

**Exit codes:** 0 success or no blocking issues, 1 if `--checks-only` finds frontmatter or broken-relation issues, 1 on internal error.

---

## page

**Synopsis:**
```bash
memory page <target> [--no-inbound]
```

**Description:**
Pretty-print a single wiki page with frontmatter, body, resolved relations, and inbound references. Outbound `relations:` entries are resolved to page paths and titles. Inbound references are other pages that link to the target via `[[wikilinks]]` or `relations:` entries. The command is read-only.

**Target resolution:**
`<target>` may be a relative path such as `projects/agentmemory.md` or `projects/agentmemory`, or a filename without extension such as `agentmemory`. If a filename-only target matches multiple pages, the command prints an error listing the candidates and asks for a relative path.

**Options:**

| Flag | Default | Description |
|---|---|---|
| `--no-inbound` | off | Skip the inbound-references scan, which is faster on large wikis |

**Examples:**
```bash
node dist/cli.mjs page agentmemory
node dist/cli.mjs page projects/agentmemory.md --no-inbound
```

**Exit codes:** 0 success, 1 if the target does not resolve or `wiki/` is missing.

---

## init

`memory init [--reset]`

Initialize `~/.memory/` with directory structure, schema template, baseline files, and git repository. Idempotent — re-running preserves existing files.

| Flag | Description |
|---|---|
| `--reset` | Destructive: archives existing `~/.memory/` to a sibling `~/.memory.reset-<timestamp>/` before re-init |

**Exit codes:** 0 success, 1 IO error.

**Example:**
```bash
memory init
# creates ~/.memory/ with schema.md, index.md, log.md, config.yaml, .gitignore, .git/
```

---

## install

`memory install <platform>`

Wire hooks (where available) + MCP for one of the supported platforms.

| Platform | What it does |
|---|---|
| `claude-code` | Writes plugin manifest + hooks.json + plugin-scoped `.mcp.json` to `~/.memory/claude-code-plugin/`. Migrates legacy `~/.claude/.mcp.json` if present. |
| `codex` | Appends sentinel-marker block to `~/.codex/config.toml` with `[[hooks.*]]` and `[mcp_servers.memory]`. Covers both Codex desktop and CLI. |
| `antigravity` | Merges memory MCP entry into `~/.gemini/antigravity/mcp_config.json`. No hooks (Antigravity has no hook system). |
| `chatgpt` | Sets up OpenAI tunnel-client profile for ChatGPT desktop connection via stdio MCP. |
| `opencode` | Writes OpenCode MCP config and selected event plugin support. |
| `opencoven` | Configures OpenCoven MCP integration. |
| `vscode` | Installs VS Code extension for memory capture. |

**Exit codes:** 0 success, 1 IO error, 2 unknown platform.

**Examples:**
```bash
memory install claude-code
memory install codex
memory install antigravity
memory install chatgpt
```

---

## grep

`memory grep <pattern> [--scope raw|wiki|both] [-C <n>]`

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

## log

`memory log "<text>" [--tag X --tag Y] [--confidence 0..1]`

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

## verify

`memory verify [--json] [--role user|operator] [--include-search]`

Run all readiness checks (vault, git, clients, compile, dashboard, search, auto-push).

**Exit codes:** 0 all pass, 1 any check fails.

---

## backfill

`memory backfill [--from <client>] [--since <date>] [--plan] [--apply]`

Import historical sessions from supported local client stores (currently Claude Code is supported via its sniffer).

| Flag | Default | Description |
|---|---|---|
| `--from <client>` | `all` | Client to backfill (e.g., `claude-code`, `all`) |
| `--since <date>` | 30 days ago | Oldest session modified time to include (e.g. `2026-05-22`) |
| `--plan` | off | Dry-run report: prints sessions that would be imported without writing files |
| `--apply` | on | Apply backfill (runs sniffers, writes sessions to `raw/`, logs audit to `wiki/.audit/`) |

**Exit codes:** 0 success, 1 error.

**Examples:**
```bash
memory backfill --from claude-code --since 2026-05-22 --plan
memory backfill --from claude-code --since 2026-05-22 --apply
```

---

## stats

`memory stats`

State summary: file counts per area, last activity, install status per platform, errors.log size, git state.

**Exit codes:** 0 always (read-only).

---

## doctor

`memory doctor`

Structural sanity check — verifies directories exist, baseline files present, plugin manifests readable, errors.log size. Exits non-zero on failures so it can gate scripts.

**Exit codes:** 0 all checks pass, 1 one or more failed.

---

## tail-errors

`memory tail-errors`

Live `tail -f` on `~/.memory/errors.log`. Ctrl+C to exit.

**Exit codes:** 0 normal exit (Ctrl+C), 1 IO error.

---

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

**Backfill historical sessions from client stores (e.g. Claude Code):**
```bash
memory backfill --from claude-code --since 30-days-ago --plan
memory backfill --from claude-code --since 30-days-ago --apply
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
