# ChatGPT Desktop Installer Design

**Date:** 2026-06-08  
**Project:** memory-system  
**Status:** Approved

## Problem

Memory-fort has platform installers for Claude Code, Codex, Claude Desktop, VS Code, Antigravity, and others. ChatGPT desktop has no integration. The user wants bidirectional memory access from within ChatGPT conversations — reading vault pages, searching memories, and logging observations back — matching the MCP tool experience already available in other supported clients.

## Constraint

ChatGPT desktop uses SSE/HTTP transport for MCP, not stdio. It cannot launch a child process directly (unlike Claude Desktop, which uses `{ "command": "node", "args": [...] }`). The MCP server must be reachable as a network endpoint. The desktop app supports `http://localhost:<port>/sse` connections; the web-only interface requires a public HTTPS URL, but the desktop app (Electron) allows localhost.

## Solution: Built-in HTTP/SSE Bridge

Add an HTTP/SSE transport mode directly to memory-fort's MCP server. A new `memory chatgpt-bridge` command starts it as a long-running HTTP server on a configured port (default 3100). `memory install chatgpt` sets up the bridge, registers it with the Windows supervisor for autostart, starts it immediately, and prints the URL + setup instructions for the user to paste into ChatGPT's Connectors UI.

No external dependencies (no ngrok, no mcp-remote). Uses `@modelcontextprotocol/sdk`'s SSE `McpServer` transport, which is already a direct dependency.

## Architecture

```
ChatGPT desktop
    ↕  SSE/HTTP  http://localhost:3100/sse
memory chatgpt-bridge (long-running Node process)
    ↕  in-process
MCP tool handlers: log_observation, search, read_page, list_pages
    ↕
~/.memory vault (config.yaml, wiki/, raw/, embeddings/)
```

The bridge runs the same MCP tool surface as the stdio server — same handlers, same vault access. Only the transport layer differs.

## Components

### `src/mcp/http-bridge.ts`

Standalone HTTP/SSE server entry point. Reads port from environment (`MEMORY_BRIDGE_PORT`) or falls back to 3100. Registers the same MCP tool handlers as `src/mcp/server.ts`. Uses `@modelcontextprotocol/sdk` SSE server transport. Exports a `startHttpBridge(port: number): Promise<void>` function and a `__main__` guard so it can be run directly as `node dist/mcp/http-bridge.mjs`.

Built by tsdown as a separate entry point alongside the existing `src/mcp/server.ts`.

### `src/cli/commands/chatgpt-bridge.ts`

CLI command: `memory chatgpt-bridge <action>`

| Action | Behavior |
|--------|----------|
| `start` | Spawn `dist/mcp/http-bridge.mjs` as a detached background process, write PID to `~/.memory/.chatgpt-bridge.pid`, print connection URL |
| `stop` | Read PID file, kill process, remove PID file |
| `status` | Check if PID is alive; probe `http://localhost:<port>/sse` with a HEAD request; print status |

Port is read from `config.yaml` → `clients.chatgpt.bridge_port` (default 3100).

### `src/cli/commands/install/chatgpt.ts`

`runInstallChatGpt(opts)`:

1. Read or default `bridge_port` (3100)
2. Check port is not in use — error with clear message if taken, suggest `--port <N>`
3. Merge `clients.chatgpt.bridge_port` into `config.yaml` via the config patch path
4. Register bridge in Windows supervisor (HKCU Run key) via existing `memory supervisor` mechanism — entry: `memory chatgpt-bridge start`
5. Start bridge immediately (call `runChatGptBridgeStart`)
6. Print success block:

```
✓ ChatGPT bridge running at http://localhost:3100/sse

Connect in ChatGPT desktop:
  Settings → Connectors → Advanced → Developer Mode
  Add connector URL: http://localhost:3100/sse

Recommended Custom Instructions:
  "At the end of each conversation, call log_observation
   with key insights, decisions, and facts worth remembering."

Run 'memory verify' to confirm setup.
```

`--port <N>` flag to override default.  
`--no-autostart` flag to skip supervisor registration.

### `src/cli/commands/uninstall/chatgpt.ts` (or inline in `uninstall.ts`)

1. Stop bridge (if running)
2. Remove supervisor entry
3. Remove `clients.chatgpt` from `config.yaml`

### `src/cli/commands/verify/chatgpt.ts`

Two `CheckDescriptor` exports:

| ID | Label | What it checks |
|----|-------|---------------|
| `chatgpt.bridge.running` | ChatGPT bridge process running | PID file exists and process is alive |
| `chatgpt.bridge.mcp` | ChatGPT bridge MCP endpoint reachable | HTTP GET `http://localhost:<port>/sse` returns 200 (or SSE headers) |

Both guarded by `skipIfClientDisabled(ctx, "chatgpt", ...)` — if the user disables ChatGPT in the dashboard client toggle card, checks are skipped.

### Config schema (`src/storage/config.ts`)

Add optional field to `MemoryConfig`:

```typescript
chatgpt?: {
  bridge_port?: number;  // default 3100
};
```

Validated: `bridge_port` must be integer 1024–65535.

## File Structure

```
src/
  mcp/
    http-bridge.ts              NEW — SSE server entry point
  cli/commands/
    chatgpt-bridge.ts           NEW — start/stop/status command
    install/
      chatgpt.ts                NEW — installer
    verify/
      chatgpt.ts                NEW — 2 verify checks
```

Modified:
- `src/cli/commands/install.ts` — add `"chatgpt"` to `Platform` union, dispatch, `planInstallWrites`
- `src/cli/commands/uninstall.ts` — add `"chatgpt"` to `UninstallPlatform`, dispatch
- `src/cli.ts` — register `chatgpt-bridge` command
- `src/cli/commands/verify/clients.ts` — push chatgpt checks to `CLIENT_CHECKS`
- `src/cli/commands/verify/registry.ts` — import + append chatgpt checks to `ALL_CHECKS`
- `src/storage/config.ts` — add `chatgpt?: { bridge_port?: number }` field + validation
- `tsdown.config.js` — add `src/mcp/http-bridge.ts` as build entry point
- `src/dashboard-ui/components/ClientsConfigCard.tsx` — add `chatgpt` toggle entry

## Capture Model

ChatGPT has these MCP tools available when connected:

| Tool | Direction | Use |
|------|-----------|-----|
| `log_observation` | write → vault | Log conversation insights |
| `search` | read ← vault | Search memories mid-conversation |
| `read_page` | read ← vault | Pull a specific wiki page |
| `list_pages` | read ← vault | Browse wiki index |

Fully bidirectional. Automatic logging requires ChatGPT Custom Instructions to instruct GPT to call `log_observation` — the installer prints a suggested snippet. No hook-level auto-capture (ChatGPT has no hook API).

## Error Handling

- Port in use at install time → clear error, exit 1, suggest `--port <N>`
- Bridge crashes after start → PID file becomes stale; `status` command detects this and reports "bridge not running"; `start` cleans up stale PID and restarts
- ChatGPT cannot reach localhost → verify check fails with `suggestedFix: "Check ChatGPT developer mode is enabled and connector URL is set"`

## Testing

- Unit: `test/cli/commands/install/chatgpt.test.ts` — mock config write, mock supervisor, mock port check
- Unit: `test/cli/commands/verify/chatgpt.test.ts` — mock PID file, mock HTTP probe
- Unit: `test/mcp/http-bridge.test.ts` — start server on random port, send MCP initialize request, assert response
- Integration: manual (ChatGPT not available in CI)

## Out of Scope

- Auto-capture of all ChatGPT conversations (no hook API available)
- macOS/Linux autostart (supervisor currently Windows-only; bridge itself works cross-platform, autostart left as follow-up)
- Public HTTPS tunnel (ngrok/cloudflare) — left as a separate future feature if localhost doesn't work for some users
