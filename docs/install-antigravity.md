# Install: Google Antigravity

## Important: MCP-only ingestion

**Antigravity desktop has no hook system** (verified May 2026 against Antigravity 2.0). Hook-based passive observation capture isn't available. Memory ingestion happens via the MCP server's `log_observation` tool — the LLM in your Antigravity session calls it explicitly when it judges something worth recording.

This is a meaningful behavioral difference from Claude Code and Codex (both of which have full hook firehose + MCP active path). On Antigravity, you get:
- **No** automatic capture of prompts / tool calls
- **Yes** explicit "remember this" via MCP `log_observation`
- **Yes** MCP `read_page` and `list_pages` for retrieval

If you want comprehensive automatic capture on Antigravity, the workaround is to prompt the LLM at session end: "Use memory log_observation to record what we learned today." Or run Claude Code / Codex in parallel for the auto-capture, and use Antigravity for whatever-it-is-you-use-Antigravity-for.

## Prerequisites

- Antigravity desktop installed and configured
- Node.js ≥ 20 on PATH
- `node dist\cli.mjs init` already run

## Install

```bash
cd C:\CodexProjects\memory-system
node dist\cli.mjs install antigravity
```

The install writes (or merges) at:

```
~/.gemini/antigravity/mcp_config.json
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

The path points at the same `mcp-server.mjs` Claude Code and Codex use — one MCP server binary serves all three platforms.

## Activate

**Restart Antigravity desktop** to load the new MCP config. Antigravity loads MCP configs at startup; in-session updates aren't picked up.

1. Close Antigravity completely (quit, not just minimize)
2. Reopen — first new session loads the memory MCP

## Verify

In an Antigravity session, ask the LLM: "What MCP tools do you have available?" — the response should list `memory.log_observation`, `memory.read_page`, `memory.list_pages` (under the `memory` namespace).

For end-to-end verification:

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

Manual: open `~/.gemini/antigravity/mcp_config.json`, remove the `memory` key from `mcpServers`. Leave other entries.

If `memory` was the only entry, the file becomes `{ "mcpServers": {} }` — that's fine; Antigravity handles empty MCP configs.

`~/.memory/` (your data) is not affected.

## Known issues

- Antigravity is MCP-only — see "Important: MCP-only ingestion" above.
- See [follow-ups.md](follow-ups.md) for ongoing items.
- See [troubleshooting.md](troubleshooting.md) for failure-mode diagnosis.
