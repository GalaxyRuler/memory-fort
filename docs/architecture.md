# Architecture

## High-Signal Integration Examples

This is an examples table, not the authoritative platform matrix. See
`docs/compatibility-matrix.md` for the current complete status, proof
requirements, and support level for each platform.

| Platform | Hooks (passive) | MCP (active) |
|---|---|---|
| **Claude Code** | yes - plugin hooks | yes - plugin MCP server |
| **Codex** | yes - local config hooks | yes - local MCP server |
| **Antigravity** | partial - live-capture plugin | yes - local MCP server |
| **OpenCode** | selected plugin event capture implemented; live smoke pending | yes - `opencode.json` local MCP config; live smoke pending |
| **OpenClaw** | no v1 hooks; gateway-level HTTP hooks are skipped | yes - OpenClaw MCP config only |
