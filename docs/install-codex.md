# Install: Codex (desktop + CLI)

A single install covers both Codex Desktop and Codex CLI — both surfaces share `~/.codex/config.toml`.

## Prerequisites

- Codex desktop OR Codex CLI installed
- Node.js ≥ 20 on PATH
- `node dist\cli.mjs init` already run (Claude Code install isn't strictly required first, but `init` is)

## Install

```bash
cd C:\CodexProjects\memory-system
node dist\cli.mjs install codex
```

The install **appends** a sentinel-marker block to `~/.codex/config.toml`. Any existing user content is preserved.

The appended block looks like:

```toml
# === BEGIN memory-system v0.1.0 ===
# DO NOT EDIT — managed by 'memory install codex'. Re-run install to update.

[[hooks.SessionStart]]
matcher = "startup|resume"

[[hooks.SessionStart.hooks]]
type = "command"
command = "node C:/Users/Admin/.memory/claude-code-plugin/scripts/session-start.mjs"

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node C:/Users/Admin/.memory/claude-code-plugin/scripts/prompt-submit.mjs"

[[hooks.PostToolUse]]

[[hooks.PostToolUse.hooks]]
type = "command"
command = "node C:/Users/Admin/.memory/claude-code-plugin/scripts/post-tool-use.mjs"

[[hooks.PreCompact]]

[[hooks.PreCompact.hooks]]
type = "command"
command = "node C:/Users/Admin/.memory/claude-code-plugin/scripts/pre-compact.mjs"

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "node C:/Users/Admin/.memory/claude-code-plugin/scripts/session-end.mjs"

[mcp_servers.memory]
command = "node"
args = ["C:/Users/Admin/.memory/claude-code-plugin/scripts/mcp-server.mjs"]

# === END memory-system v0.1.0 ===
```

Codex doesn't expand `${CLAUDE_PLUGIN_ROOT}` or `~` — absolute paths are used, resolved at install time. Both Codex desktop and Codex CLI read this same file.

## Activate

**Restart any open Codex sessions** to pick up the new config. Codex loads `config.toml` at startup; in-session updates aren't applied to running sessions.

If Codex desktop is open:
- Close it completely (right-click tray icon → Quit if present)
- Reopen — the next session loads the new hooks + MCP

If you only use Codex CLI:
- Next `codex` invocation picks up the new config automatically

## Verify

```bash
codex mcp list
# Should include: memory: node C:/Users/Admin/.memory/claude-code-plugin/scripts/mcp-server.mjs - ✓ Connected
```

```bash
codex config show | grep -A2 "mcp_servers.memory"
# Or just inspect the file:
grep -A5 "mcp_servers.memory" ~/.codex/config.toml
```

For end-to-end verification, run a Codex session that uses a tool, then check:

```bash
ls ~/.memory/raw/$(date -u +%Y-%m-%d)/codex-*.md
```

A `codex-<session-id>.md` should appear with frontmatter declaring `source: codex`.

## Re-install

`memory install codex` is idempotent. Re-running:
- Detects the existing `# === BEGIN memory-system ===` ... `# === END ===` block
- Removes it (the strip-prior-block step)
- Appends a fresh block at the end of the file

Your other Codex configuration (model, sandbox, agents, etc.) is preserved untouched. Comments outside our block are preserved.

## Uninstall

Manual: open `~/.codex/config.toml` and delete the lines from `# === BEGIN memory-system v0.1.0 ===` through `# === END memory-system v0.1.0 ===` inclusive.

`~/.memory/` (your data) is not affected.

## Codex version notes

- `PreCompact` and `PostCompact` hook events were added in Codex 0.129.0 (April 26, 2026). On older Codex, those entries are parsed but silently ignored.
- Other hook events (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`) are supported back to Codex's hooks-introduction release.

## Known issues

- See [follow-ups.md](follow-ups.md) for ongoing items.
- See [troubleshooting.md](troubleshooting.md) for failure-mode diagnosis.
