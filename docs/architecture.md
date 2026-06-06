# Architecture

## Integration table

| Platform | Hooks (passive) | MCP (active) |
|---|---|---|
| **Claude Code** | yes - plugin hooks | yes - plugin MCP server |
| **Codex** | yes - local config hooks | yes - local MCP server |
| **Antigravity** | partial - live-capture plugin | yes - local MCP server |
| **OpenCode** | partial - plugin event capture for selected events | yes - `opencode.json` local MCP server |
