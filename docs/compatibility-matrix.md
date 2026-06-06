# Memory Fort Compatibility Matrix

This matrix tracks what Memory Fort claims, what is installed by the CLI, and what has fresh verification evidence.

| Tool | Install command | Capture path | Recall path | Fresh proof required for v1.1 | Status |
|---|---|---|---|---|---|
| Claude Code | `memory-fort install claude-code` | Plugin hooks | Plugin MCP + session-start context | Plugin enabled, hook paths resolve, one raw capture, one MCP search | certification required |
| Codex | `memory-fort install codex` | `~/.codex/config.toml` hooks | MCP + session-start context | Config block, one raw capture, one MCP search | certification required |
| Antigravity | `memory-fort install antigravity` | Live-capture plugin | MCP | Plugin installed, one raw capture, one MCP call | certification required |
| OpenCode | `memory-fort install opencode` | OpenCode plugin events | OpenCode local MCP | Config entry, plugin file, one event capture, one MCP list/search smoke | implementation required |
| Hermes | `memory-fort install hermes` | YAML hooks | MCP | Config block and capture freshness when installed | supported |
| Pi | `memory-fort install pi` | YAML hooks | none in v1 | Config block and capture freshness when installed | supported |
| OpenClaw | `memory-fort install openclaw` | none in v1 | MCP | Config entry preserved and updated idempotently | supported |
| OpenCoven | `memory-fort install opencoven` | none | readiness check only | Readiness contract result | read-only |
| Claude Desktop | `memory-fort install claude-desktop` | none | MCP | MCP config entry | supported |
| VS Code | `memory-fort install vscode` | extension shell | MCP | MCP config entry and extension copy | supported |
