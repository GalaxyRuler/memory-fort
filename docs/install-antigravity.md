# Install: Google Antigravity

## Capture model: plugin hooks + MCP

Antigravity desktop 2.0 supports live-capture plugin hooks. `memory install antigravity` installs both:

- Passive plugin hooks for prompts, responses, tool calls, context compaction, and session lifecycle events
- MCP `log_observation` for explicit "remember this" writes
- MCP `read_page`, `list_pages`, and `search` for retrieval

If version detection is unavailable, the installer assumes an Antigravity 2.0-compatible plugin surface and installs the live-capture plugin. It skips hook installation only when it detects a known pre-2.0 Antigravity version.

## Prerequisites

- Antigravity desktop installed and configured
- Node.js ≥ 20 on PATH
- `node dist\cli.mjs init` already run

## Install

```bash
cd C:\CodexProjects\memory-system
node dist\cli.mjs install antigravity
```

The install writes (or merges) MCP configuration at:

```
~/.gemini/antigravity/mcp_config.json
```

It also writes the live-capture plugin at:

```
~/.gemini/antigravity/plugins/memory/
```

Content shape (merged with any existing entries — your other MCPs are preserved):

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": [
        "C:/Users/Admin/.memory/claude-code-plugin/scripts/mcp-server.mjs"
      ]
    }
  }
}
```

The MCP path points at the same `mcp-server.mjs` Claude Code and Codex use. The plugin hook scripts are Antigravity-specific and append raw captures under `~/.memory/raw/<date>/antigravity-<session>.md`.

## Activate

**Restart Antigravity desktop** to load the new MCP config and plugin hooks. In-session updates are not picked up.

1. Close Antigravity completely (quit, not just minimize)
2. Reopen — first new session loads the memory MCP and live-capture plugin

## Verify

In an Antigravity session, ask the LLM: "What MCP tools do you have available?" The response should list `memory.log_observation`, `memory.read_page`, `memory.list_pages`, and `memory.search` under the `memory` namespace.

After a new Antigravity session, check automatic captures from a terminal:

```bash
ls ~/.memory/raw/$(date -u +%Y-%m-%d)/antigravity-*.md
```

For explicit MCP verification:

> "Use memory.log_observation with text='antigravity install verified' and source='manual'."

The LLM should call the tool and confirm. Then check from a terminal:

```bash
ls ~/.memory/raw/$(date -u +%Y-%m-%d)/manual-*.md
cat ~/.memory/raw/$(date -u +%Y-%m-%d)/manual-*.md
```

A `manual-mcp-<timestamp>.md` file appears with the observation text.

## Note on path variations

You may notice three other empty MCP config files on your machine:

- `~/.gemini/antigravity-backup/mcp_config.json`
- `~/.gemini/antigravity-ide/mcp_config.json`
- `~/.gemini/config/mcp_config.json`

These are stale artifacts from the Antigravity 2.0 rebrand (Antigravity-IDE → Antigravity). The canonical current path is `~/.gemini/antigravity/mcp_config.json` (per Antigravity 2.0 docs as of May 2026). Our install writes there only; we don't touch the stale paths.

If a future Antigravity version changes the canonical path, `memory install antigravity` will need updating. File a follow-up if you find the install writes to the wrong place.

## Re-install

`memory install antigravity` is idempotent. Re-running:
- Reads existing `mcp_config.json`
- Preserves all other `mcpServers` entries
- Updates only the `memory` key

## Uninstall

Manual: open `~/.gemini/antigravity/mcp_config.json`, remove the `memory` key from `mcpServers`, and delete `~/.gemini/antigravity/plugins/memory/`. Leave other MCP entries.

If `memory` was the only entry, the file becomes `{ "mcpServers": {} }` — that's fine; Antigravity handles empty MCP configs.

`~/.memory/` (your data) is not affected.

## Known issues

- Antigravity must be fully restarted after install before live hooks fire.
- See [follow-ups.md](follow-ups.md) for ongoing items.
- See [troubleshooting.md](troubleshooting.md) for failure-mode diagnosis.
