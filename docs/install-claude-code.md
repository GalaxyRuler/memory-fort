# Install: Claude Code

## Prerequisites

- Claude Code installed (`claude --version` succeeds)
- Node.js ≥ 20 on PATH
- The memory-system repo built locally: `cd C:\CodexProjects\memory-system && npm install && npm run build`

## Install

```bash
cd C:\CodexProjects\memory-system
node dist\cli.mjs init                    # creates ~/.memory/ with schema + git
node dist\cli.mjs install claude-code     # writes plugin manifest + hooks + MCP config
```

The install creates:

```
~/.memory/claude-code-plugin/
  .claude-plugin/plugin.json   ← plugin manifest (author as object, per Claude Code's manifest validator)
  hooks/hooks.json             ← five hook events: SessionStart, UserPromptSubmit, PostToolUse, PreCompact, Stop
  .mcp.json                    ← plugin-bundled MCP config (memory server, ${CLAUDE_PLUGIN_ROOT} path)
  scripts/                     ← symlink/junction → <source-repo>/dist/hooks/
```

Note: `~/.claude/.mcp.json` is **NOT** touched by Phase 1 install. If a prior install (steps #7 / #7-fix-1) left a `memory` entry there, the current install migrates it out automatically.

## Activate the plugin in Claude Code

Two equivalent paths — pick one.

### Option 1: Per-session activation via `--plugin-dir`

```bash
claude --plugin-dir C:\Users\Admin\.memory\claude-code-plugin
```

Each session you start this way loads the memory plugin and its hooks + MCP. Simple, no global config changes.

### Option 2: Marketplace-style install (persistent)

In an active Claude Code session:

```
/plugin marketplace add C:\Users\Admin\.memory\claude-code-plugin
/plugin install memory@local
```

After this, the plugin is enabled persistently — every new Claude Code session in any project loads it.

## Verify

```bash
node dist\cli.mjs doctor
# All checks should pass except those needing live session activity.

node dist\cli.mjs stats
# Hooks installed: claude-code ✓
```

For end-to-end verification, start a session and use a tool (any Read/Bash/Glob will do):

```bash
claude --plugin-dir ~/.memory/claude-code-plugin -p "Use the Bash tool to echo hello"
ls ~/.memory/raw/$(date -u +%Y-%m-%d)/
```

A `claude-code-<session-uuid>.md` file should appear with:
- Frontmatter declaring `source: claude-code`
- `## Prompt` block with your prompt
- `## ToolUse: Bash` block with input + (possibly empty per follow-up F1) output

## Verify the MCP server is callable

In an active session, ask Claude to invoke a memory tool:

> "Call the memory log_observation MCP tool with text='install verified' and source='manual'."

Or via the headless mode:

```bash
claude --plugin-dir ~/.memory/claude-code-plugin -p "Use mcp__plugin_memory_memory__log_observation with text='hello' and source='manual'" --allowedTools "mcp__plugin_memory_memory__log_observation"
ls ~/.memory/raw/$(date -u +%Y-%m-%d)/manual-*.md
```

A new `manual-mcp-<timestamp>.md` should appear with the observation text.

## Re-install

`memory install claude-code` is idempotent. Re-running:
- Overwrites the plugin manifest and hooks.json with the latest content
- Re-creates the scripts symlink if needed
- Re-writes the plugin's `.mcp.json`
- Migrates any legacy `~/.claude/.mcp.json` entry

Safe to run anytime — e.g., after a `npm run build` that changed the hook scripts.

## Uninstall

Manual cleanup:

```bash
rm -rf ~/.memory/claude-code-plugin/
# In Claude Code: /plugin uninstall memory  (or /plugin marketplace remove ~/.memory/claude-code-plugin)
```

`~/.memory/raw/`, `~/.memory/wiki/`, etc. survive — uninstall doesn't delete your data.

## Known issues

- See [follow-ups.md](follow-ups.md) — particularly F1 (empty ToolUse output capture) and F2 (build-time PLUGIN_TIMINGS warnings, cosmetic).
- See [troubleshooting.md](troubleshooting.md) for failure-mode diagnosis.
