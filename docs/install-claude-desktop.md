# Install: Claude Desktop

## What This Does

`memory install claude-desktop` adds the memory MCP server to Claude Desktop's MCP configuration. It is MCP-only: Claude Desktop does not run memory hooks, so there is no passive prompt/tool firehose. Claude can still use the MCP tools to search, read, list, and explicitly log observations.

The installer preserves any existing `mcpServers` entries and updates only the `memory` key.

## Config Locations

Windows:

```text
%APPDATA%\Claude\claude_desktop_config.json
```

macOS:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Linux fallback:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Tests and smoke runs can override the config directory with `MEMORY_CLAUDE_DESKTOP_DIR`.

## Install

```bash
cd C:\CodexProjects\memory-system
node dist\cli.mjs install claude-desktop
```

Sample output:

```text
Installed memory MCP for Claude Desktop at C:\Users\Admin\AppData\Roaming\Claude\claude_desktop_config.json
  memory MCP entry created
  preserved 0 other MCP server(s)

Next steps:
  1. Restart Claude Desktop to load the memory MCP server.
  2. Open Settings → Developer → MCP Servers and confirm memory is listed.
  3. Claude Desktop is MCP-only — no hooks are installed for passive capture.
```

The config shape is:

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

## Verify

Restart Claude Desktop. Config changes are loaded on app restart, not in the current running session.

Then open:

```text
Settings → Developer → MCP Servers
```

The server list should include `memory`.

In a chat, ask Claude what memory tools are available. It should be able to use tools such as `memory.search`, `memory.read_page`, `memory.list_pages`, and `memory.log_observation`.

## Troubleshooting

- If `memory` is not listed, quit Claude Desktop completely and reopen it.
- If Claude reports `node` is missing, install Node.js 20+ and confirm `node` is on PATH.
- If the config already had other MCP servers, verify they are still present under `mcpServers`.
- If the config file is malformed JSON, fix it manually or move it aside before re-running the installer.
- Claude Desktop is MCP-only. For automatic hook capture, use Claude Code or Codex installs.
