# Memory Fort Compatibility Matrix

This matrix keeps three claims separate: **supported** means an installer/contract exists; **installed** is local machine state reported by `/api/clients/status`; **certified** requires the listed live proof. An installed configuration is not automatically certified.

| Tool | Supported contract | Installed state | Certification evidence | Certified |
|---|---|---|---|---|
| Claude Code | Plugin hooks + MCP | Inspect plugin, hook paths, and enablement | One raw capture and bounded MCP `tools/list`/search smoke | pending live smoke |
| Codex | `config.toml` hooks + MCP | Inspect config and referenced executables | One raw capture and bounded MCP `tools/list`/search smoke | pending live smoke |
| Antigravity | Live-capture plugin + MCP | Inspect configured plugin/MCP entry | One raw capture and MCP smoke | pending live smoke |
| OpenCode | Selected plugin events + local MCP | Inspect config, plugin, and referenced scripts | Selected event capture and MCP list/search smoke | pending live smoke |
| Hermes | YAML hooks + MCP | Inspect hook block and referenced script | Capture freshness and MCP smoke | pending live smoke |
| Pi | YAML hooks only | Inspect hook block and referenced script | Capture freshness | pending live smoke |
| OpenClaw | MCP only | Inspect MCP entry | Bounded MCP smoke | pending live smoke |
| OpenCoven | Read-only readiness | Readiness contract result | Not applicable | not claimed |
| Claude Desktop | MCP only | Inspect MCP entry | Bounded MCP smoke | pending live smoke |
| VS Code | MCP + extension shell | Inspect MCP entry and extension | Extension capture and MCP smoke | pending live smoke |

`/api/clients/status` reports only local installation/health evidence. It does not set certification, mutate a client configuration, or turn a disabled client on.
