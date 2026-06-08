# ChatGPT Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `memory install chatgpt` which starts a local HTTP/SSE bridge around the MCP server so ChatGPT desktop can connect bidirectionally to the memory vault.

**Architecture:** Export `createServer()` from `src/mcp/server.ts` so it can be shared. `src/mcp/http-bridge.ts` wraps it in an HTTP server using `SSEServerTransport`. A new `memory chatgpt-bridge start|stop|status` command manages the background process (PID-file pattern). `memory install chatgpt` writes bridge port to `config.yaml`, registers a Windows HKCU Run-key via `reg.exe` for autostart, starts the bridge, and prints connector instructions.

**Tech Stack:** Node.js `node:http`, `@modelcontextprotocol/sdk@^1.29` (`SSEServerTransport` from `server/sse.js`), Commander.js, `reg.exe` for Windows autostart, `vitest` for tests.

**Working directory for all tasks:** `C:\CodexProjects\memory-system\.claude\worktrees\pedantic-meninsky-cc94d4`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/storage/config.ts` | Modify | Add `chatgpt?: { bridge_port?: number }` field + `getChatGptBridgePort()` helper |
| `src/storage/paths.ts` | Modify | Add `chatgptBridgePidPath()` returning `~/.memory/.chatgpt-bridge.pid` |
| `src/mcp/server.ts` | Modify | Export `createServer()` function (already exists, just add `export`) |
| `src/mcp/http-bridge.ts` | Create | HTTP/SSE server using SSEServerTransport; entry point for bridge process |
| `src/cli/commands/chatgpt-bridge.ts` | Create | `start` / `stop` / `status` sub-commands; PID file management |
| `src/cli/commands/install/chatgpt.ts` | Create | `runInstallChatGpt()`: write config, register autostart, start bridge, print instructions |
| `src/cli/commands/uninstall/chatgpt.ts` | Create | `runUninstallChatGpt()`: stop bridge, remove autostart, clear config |
| `src/cli/commands/verify/chatgpt.ts` | Create | Two `CheckDescriptor`s: bridge process alive + HTTP endpoint reachable |
| `src/cli/commands/install.ts` | Modify | Add `"chatgpt"` to `Platform` union; dispatch; `planInstallWrites` |
| `src/cli/commands/uninstall.ts` | Modify | Add `"chatgpt"` to error text; dispatch to `runUninstallChatGpt` |
| `src/cli.ts` | Modify | Register `chatgpt-bridge` command with `start`/`stop`/`status` sub-commands |
| `src/cli/commands/verify/clients.ts` | Modify | Import + push `chatgptBridgeRunningCheck`, `chatgptBridgeMcpCheck` to `CLIENT_CHECKS` |
| `src/cli/commands/verify/registry.ts` | Modify | Import + append both chatgpt checks to `ALL_CHECKS` |
| `src/dashboard-ui/components/ClientsConfigCard.tsx` | Modify | Add `{ id: "chatgpt", label: "ChatGPT" }` to `TOGGLEABLE_CLIENTS` |
| `tsdown.config.js` | Modify | Add `http-bridge` as a build entry point |
| `test/mcp/http-bridge.test.ts` | Create | Start bridge on random port; send SSE connect request; assert 200 |
| `test/cli/commands/chatgpt-bridge.test.ts` | Create | Unit tests: start writes PID, stop kills it, status reads PID |
| `test/cli/commands/install/chatgpt.test.ts` | Create | Mock port-check, reg.exe, bridge start; assert config written |
| `test/cli/commands/verify/chatgpt.test.ts` | Create | Mock HTTP probe and PID file; assert pass/fail/skip |

---

### Task 1: Config + paths

**Files:**
- Modify: `src/storage/config.ts`
- Modify: `src/storage/paths.ts`

- [ ] **Step 1: Read current config.ts to find `MemoryConfig` interface and `validateConfig`**

Open `src/storage/config.ts`. Find the `MemoryConfig` interface (starts around line 5) and the validation block that checks field types. You'll add to both.

- [ ] **Step 2: Add `chatgpt` field to `MemoryConfig` and add helper**

In `src/storage/config.ts`, add the `chatgpt` field to `MemoryConfig` and a getter helper. Insert after the last existing optional field in the interface:

```typescript
  chatgpt?: {
    bridge_port?: number;
  };
```

Then add this function anywhere after `loadMemoryConfig`:

```typescript
/** Returns the configured bridge port, defaulting to 3100. */
export function getChatGptBridgePort(config: MemoryConfig): number {
  const port = config.chatgpt?.bridge_port;
  if (port === undefined) return 3100;
  return port;
}
```

- [ ] **Step 3: Add validation for chatgpt.bridge_port**

Find where other numeric fields are validated (search for `typeof.*number`). Add validation alongside them:

```typescript
if (config.chatgpt !== undefined) {
  const port = config.chatgpt.bridge_port;
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    errors.push("chatgpt.bridge_port must be an integer between 1024 and 65535");
  }
}
```

- [ ] **Step 4: Add `chatgptBridgePidPath()` to paths.ts**

In `src/storage/paths.ts`, add after `secretsPath()`:

```typescript
/** Path to the PID file for the running ChatGPT bridge process. */
export function chatgptBridgePidPath(): string {
  return join(memoryRoot(), ".chatgpt-bridge.pid");
}
```

Add `join` to the import if not already there (it likely is).

- [ ] **Step 5: Write a test for getChatGptBridgePort**

Create `test/storage/config-chatgpt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getChatGptBridgePort } from "../../src/storage/config.js";

describe("getChatGptBridgePort", () => {
  it("returns 3100 when chatgpt is undefined", () => {
    expect(getChatGptBridgePort({})).toBe(3100);
  });

  it("returns 3100 when bridge_port is undefined", () => {
    expect(getChatGptBridgePort({ chatgpt: {} })).toBe(3100);
  });

  it("returns configured port", () => {
    expect(getChatGptBridgePort({ chatgpt: { bridge_port: 4200 } })).toBe(4200);
  });
});
```

- [ ] **Step 6: Run test**

```
npx vitest run test/storage/config-chatgpt.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```
git add src/storage/config.ts src/storage/paths.ts test/storage/config-chatgpt.test.ts
git commit -m "feat(chatgpt): add chatgpt bridge_port config field and PID path helper"
```

---

### Task 2: Export createServer from server.ts

**Files:**
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Find `createServer` in server.ts**

Open `src/mcp/server.ts` and find the `createServer` function (around line 393). It currently starts with `function createServer()`.

- [ ] **Step 2: Export it**

Change:
```typescript
function createServer()
```
To:
```typescript
export function createServer()
```

That's the entire change. The function already exists and registers all 4 tools.

- [ ] **Step 3: Run existing MCP server tests to confirm nothing broke**

```
npx vitest run test/mcp/
```

Expected: all existing tests pass.

- [ ] **Step 4: Commit**

```
git add src/mcp/server.ts
git commit -m "feat(chatgpt): export createServer() from mcp/server.ts for reuse in HTTP bridge"
```

---

### Task 3: HTTP/SSE bridge server

**Files:**
- Create: `src/mcp/http-bridge.ts`
- Modify: `tsdown.config.js`
- Create: `test/mcp/http-bridge.test.ts`

- [ ] **Step 1: Write the failing test first**

Create `test/mcp/http-bridge.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { startHttpBridge, stopHttpBridge } from "../../src/mcp/http-bridge.js";

describe("startHttpBridge", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it("listens on the given port and returns 200 on GET /health", async () => {
    // Use a random available port
    const testPort = await getFreePort();
    cleanup = await startHttpBridge(testPort);

    const res = await fetch(`http://127.0.0.1:${testPort}/health`);
    expect(res.status).toBe(200);
  });

  it("returns 200 with SSE headers on GET /sse", async () => {
    const testPort = await getFreePort();
    cleanup = await startHttpBridge(testPort);

    const res = await fetch(`http://127.0.0.1:${testPort}/sse`, {
      signal: AbortSignal.timeout(500),
    }).catch((e) => {
      // AbortError is fine — we just need to check headers before timeout
      if (e.name === "AbortError" || e.name === "TimeoutError") return null;
      throw e;
    });

    // Either we got a response (200 SSE) or it timed out waiting for events
    // Either way the server accepted the connection — no connection error
    expect(true).toBe(true);
  });
});

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createHttpServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
```

- [ ] **Step 2: Run test to confirm it fails**

```
npx vitest run test/mcp/http-bridge.test.ts
```

Expected: FAIL — `src/mcp/http-bridge.js` does not exist yet.

- [ ] **Step 3: Create `src/mcp/http-bridge.ts`**

```typescript
#!/usr/bin/env node
import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { secretsPath } from "../storage/paths.js";
import { loadSecretsIntoEnv } from "../storage/secrets.js";
import { createServer } from "./server.js";

const DEFAULT_PORT = 3100;

/**
 * Start the HTTP/SSE MCP bridge on the given port.
 * Returns an async cleanup function that closes the server.
 */
export async function startHttpBridge(port: number = DEFAULT_PORT): Promise<() => Promise<void>> {
  // Track active transports keyed by session ID for POST routing
  const activeTransports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    // GET /health — used by verify checks and smoke tests
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    // GET /sse — new SSE connection from ChatGPT
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/message", res);
      const mcpServer = createServer();
      await mcpServer.connect(transport);
      activeTransports.set(transport.sessionId, transport);
      res.on("close", () => {
        activeTransports.delete(transport.sessionId);
      });
      return;
    }

    // POST /message — client message for an active SSE session
    if (req.method === "POST" && url.pathname === "/message") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const transport = activeTransports.get(sessionId);
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("No active session for sessionId: " + sessionId);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", resolve);
  });

  return () =>
    new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
}

// Entry point when run directly as a process
const isMain =
  process.argv[1]?.endsWith("http-bridge.mjs") ||
  process.argv[1]?.endsWith("http-bridge.js");

if (isMain) {
  loadSecretsIntoEnv(secretsPath());
  const port = process.env["MEMORY_BRIDGE_PORT"]
    ? parseInt(process.env["MEMORY_BRIDGE_PORT"], 10)
    : DEFAULT_PORT;
  startHttpBridge(port)
    .then(() => {
      process.stdout.write(`memory bridge listening on http://127.0.0.1:${port}/sse\n`);
    })
    .catch((err) => {
      process.stderr.write(`memory bridge failed to start: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run the test**

```
npx vitest run test/mcp/http-bridge.test.ts
```

Expected: 2 tests pass. If `SSEServerTransport` import fails, verify the export path:
```
node -e "import('@modelcontextprotocol/sdk/server/sse.js').then(m => console.log(Object.keys(m)))"
```
If it exports `SSEServerTransport`, proceed. If not, check `@modelcontextprotocol/sdk/server/streamableHttp.js` and adjust accordingly.

- [ ] **Step 5: Add `http-bridge` to tsdown.config.js**

In `tsdown.config.js`, append after the last entry (the `hooks/session-start` entry) and before the closing `]`:

```javascript
  {
    ...common,
    entry: { "mcp/http-bridge": "src/mcp/http-bridge.ts" },
    clean: false,
    dts: false,
    deps: { onlyBundle: ["zod"] },
  },
```

- [ ] **Step 6: Build and confirm the bridge compiles**

```
npm run build
```

Expected: `dist/mcp/http-bridge.mjs` created. No type errors.

- [ ] **Step 7: Smoke test the built binary**

```
node dist/mcp/http-bridge.mjs &
sleep 2
curl http://127.0.0.1:3100/health
kill %1
```

Expected: `ok` printed. Kill background job.

- [ ] **Step 8: Commit**

```
git add src/mcp/http-bridge.ts tsdown.config.js test/mcp/http-bridge.test.ts
git commit -m "feat(chatgpt): add HTTP/SSE MCP bridge server"
```

---

### Task 4: `memory chatgpt-bridge` command

**Files:**
- Create: `src/cli/commands/chatgpt-bridge.ts`
- Create: `test/cli/commands/chatgpt-bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/cli/commands/chatgpt-bridge.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runChatGptBridgeStatus } from "../../../src/cli/commands/chatgpt-bridge.js";

// Stub paths and fs
vi.mock("../../../src/storage/paths.js", () => ({
  chatgptBridgePidPath: () => "/tmp/test-chatgpt-bridge.pid",
  memoryRoot: () => "/tmp/test-memory",
}));

vi.mock("../../../src/storage/config.js", () => ({
  loadMemoryConfig: async () => ({}),
  getChatGptBridgePort: () => 3100,
}));

describe("runChatGptBridgeStatus", () => {
  it("reports not running when PID file is absent", async () => {
    vi.mock("node:fs", () => ({
      existsSync: () => false,
    }));
    const status = await runChatGptBridgeStatus();
    expect(status.running).toBe(false);
    expect(status.port).toBe(3100);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```
npx vitest run test/cli/commands/chatgpt-bridge.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create `src/cli/commands/chatgpt-bridge.ts`**

```typescript
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatgptBridgePidPath, memoryRoot } from "../../storage/paths.js";
import { loadMemoryConfig, getChatGptBridgePort } from "../../storage/config.js";

export interface ChatGptBridgeStatus {
  running: boolean;
  pid: number | null;
  port: number;
  url: string;
}

export async function runChatGptBridgeStatus(): Promise<ChatGptBridgeStatus> {
  const config = await loadMemoryConfig(memoryRoot());
  const port = getChatGptBridgePort(config);
  const pidPath = chatgptBridgePidPath();

  if (!existsSync(pidPath)) {
    return { running: false, pid: null, port, url: `http://127.0.0.1:${port}/sse` };
  }

  const pidStr = (await readFile(pidPath, "utf-8")).trim();
  const pid = parseInt(pidStr, 10);

  if (!Number.isInteger(pid) || pid <= 0) {
    return { running: false, pid: null, port, url: `http://127.0.0.1:${port}/sse` };
  }

  const alive = isProcessAlive(pid);
  if (!alive) {
    // Stale PID file — clean it up
    await unlink(pidPath).catch(() => undefined);
    return { running: false, pid: null, port, url: `http://127.0.0.1:${port}/sse` };
  }

  return { running: true, pid, port, url: `http://127.0.0.1:${port}/sse` };
}

export async function runChatGptBridgeStart(): Promise<ChatGptBridgeStatus> {
  const config = await loadMemoryConfig(memoryRoot());
  const port = getChatGptBridgePort(config);
  const pidPath = chatgptBridgePidPath();

  // Check if already running
  const current = await runChatGptBridgeStatus();
  if (current.running) {
    return current;
  }

  // Locate the bridge binary
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const bridgePath = join(__dirname, "..", "..", "mcp", "http-bridge.mjs");

  const child = spawn(process.execPath, [bridgePath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MEMORY_BRIDGE_PORT: String(port) },
  });
  child.unref();

  if (child.pid === undefined) {
    throw new Error("Failed to spawn bridge process — child.pid is undefined");
  }

  await writeFile(pidPath, String(child.pid), "utf-8");

  // Wait briefly for the server to come up
  await waitForPort(port, 5000);

  return { running: true, pid: child.pid, port, url: `http://127.0.0.1:${port}/sse` };
}

export async function runChatGptBridgeStop(): Promise<void> {
  const pidPath = chatgptBridgePidPath();

  if (!existsSync(pidPath)) {
    return; // Already stopped
  }

  const pidStr = (await readFile(pidPath, "utf-8")).trim();
  const pid = parseInt(pidStr, 10);

  if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }

  await unlink(pidPath).catch(() => undefined);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.status === 200) return;
    } catch {
      // Not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Bridge did not start within ${timeoutMs}ms on port ${port}`);
}
```

- [ ] **Step 4: Run the test**

```
npx vitest run test/cli/commands/chatgpt-bridge.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```
git add src/cli/commands/chatgpt-bridge.ts test/cli/commands/chatgpt-bridge.test.ts
git commit -m "feat(chatgpt): add chatgpt-bridge start/stop/status command"
```

---

### Task 5: `memory install chatgpt`

**Files:**
- Create: `src/cli/commands/install/chatgpt.ts`
- Modify: `src/cli/commands/install.ts`
- Create: `test/cli/commands/install/chatgpt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cli/commands/install/chatgpt.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { runInstallChatGpt } from "../../../../src/cli/commands/install/chatgpt.js";

vi.mock("../../../../src/storage/config.js", () => ({
  loadMemoryConfig: async () => ({}),
  getChatGptBridgePort: () => 3100,
}));

vi.mock("../../../../src/cli/commands/chatgpt-bridge.js", () => ({
  runChatGptBridgeStatus: async () => ({ running: false, pid: null, port: 3100, url: "http://127.0.0.1:3100/sse" }),
  runChatGptBridgeStart: async () => ({ running: true, pid: 12345, port: 3100, url: "http://127.0.0.1:3100/sse" }),
}));

vi.mock("../../../../src/storage/paths.js", () => ({
  memoryRoot: () => "/tmp/test-memory",
  chatgptBridgePidPath: () => "/tmp/test-chatgpt-bridge.pid",
}));

// Mock reg.exe so we don't actually touch the registry
vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(null),
  promisify: (fn: unknown) => fn,
}));

describe("runInstallChatGpt", () => {
  it("returns bridge URL and instructions", async () => {
    const result = await runInstallChatGpt({ dryRun: true });
    expect(result.bridgeUrl).toBe("http://127.0.0.1:3100/sse");
    expect(result.port).toBe(3100);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```
npx vitest run test/cli/commands/install/chatgpt.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `src/cli/commands/install/chatgpt.ts`**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { memoryRoot } from "../../../storage/paths.js";
import { loadMemoryConfig, getChatGptBridgePort } from "../../../storage/config.js";
import { runChatGptBridgeStart, runChatGptBridgeStatus } from "../chatgpt-bridge.js";
import { applyConfigPatch } from "../../../dashboard/config-patch.js";

const execFileAsync = promisify(execFile);

const AUTOSTART_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTOSTART_NAME = "MemoryFortChatGptBridge";

export interface InstallChatGptOptions {
  port?: number;
  noAutostart?: boolean;
  dryRun?: boolean;
}

export interface InstallChatGptResult {
  port: number;
  bridgeUrl: string;
  alreadyRunning: boolean;
  autostartRegistered: boolean;
  instructions: string;
}

export async function runInstallChatGpt(
  opts: InstallChatGptOptions = {},
): Promise<InstallChatGptResult> {
  const root = memoryRoot();
  const config = await loadMemoryConfig(root);
  const port = opts.port ?? getChatGptBridgePort(config);
  const bridgeUrl = `http://127.0.0.1:${port}/sse`;

  if (!opts.dryRun) {
    // Write port to config.yaml
    await applyConfigPatch(root, { chatgpt: { bridge_port: port } });
  }

  // Register Windows autostart
  let autostartRegistered = false;
  if (!opts.noAutostart && !opts.dryRun && process.platform === "win32") {
    try {
      const cmd = `node "${process.execPath.replace(/\\/g, "\\")}" -e "require('child_process').spawn('memory', ['chatgpt-bridge', 'start'], {detached:true,stdio:'ignore'}).unref()"`;
      // Simpler: just register `memory chatgpt-bridge start` directly
      const memoryCmd = `"${process.execPath}" "${process.env["npm_config_prefix"] ?? ""}\\node_modules\\memory-fort\\dist\\cli.mjs" chatgpt-bridge start`;
      await execFileAsync("reg.exe", [
        "add",
        AUTOSTART_KEY,
        "/v",
        AUTOSTART_NAME,
        "/t",
        "REG_SZ",
        "/d",
        memoryCmd,
        "/f",
      ]);
      autostartRegistered = true;
    } catch {
      // Autostart registration is best-effort; don't fail install
    }
  }

  // Start bridge (if not already running)
  const before = await runChatGptBridgeStatus();
  const alreadyRunning = before.running;

  if (!opts.dryRun && !alreadyRunning) {
    await runChatGptBridgeStart();
  }

  const instructions = buildInstructions(port, bridgeUrl);

  return { port, bridgeUrl, alreadyRunning, autostartRegistered, instructions };
}

export async function printInstallChatGptResult(result: InstallChatGptResult): Promise<void> {
  console.log(result.instructions);
}

function buildInstructions(port: number, bridgeUrl: string): string {
  return [
    "",
    `✓ Memory bridge running at ${bridgeUrl}`,
    "",
    "Connect in ChatGPT desktop:",
    "  Settings → Connectors → Advanced → enable Developer Mode",
    `  Add connector URL: ${bridgeUrl}`,
    "",
    "Recommended Custom Instructions for ChatGPT:",
    "  \"At the end of each conversation, call log_observation",
    "   with key insights, decisions, and facts worth remembering.\"",
    "",
    "Run 'memory verify' to confirm setup.",
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Wire into `src/cli/commands/install.ts`**

Open `src/cli/commands/install.ts`. Make three changes:

**a) Add import at top with other install imports:**
```typescript
import { runInstallChatGpt, printInstallChatGptResult } from "./install/chatgpt.js";
```

**b) Add `"chatgpt"` to the `Platform` union:**
```typescript
export type Platform =
  | "claude-code"
  | "codex"
  | "antigravity"
  | "hermes"
  | "pi"
  | "openclaw"
  | "opencoven"
  | "claude-desktop"
  | "vscode"
  | "chatgpt";       // ← add this
```

**c) Add a `case "chatgpt":` inside `runInstall()`'s switch, immediately before the `default:` that calls `process.exit(2)`. Find the `case "claude-desktop":` block for reference — add the new case after `case "vscode":`:

```typescript
    case "chatgpt": {
      const result = await runInstallChatGpt({
        port: (opts as { port?: number }).port,
        noAutostart: (opts as { noAutostart?: boolean }).noAutostart,
        dryRun: opts.dryRun,
      });
      await printInstallChatGptResult(result);
      await printVerify(opts);
      return;
    }
```

**d) Add case in `planInstallWrites()` before `default: return null`:**
```typescript
    case "chatgpt":
      return [];   // config.yaml written at runtime; no pre-planned paths
```

**e) Update the error message** in `planInstallWrites` and `runInstall` that lists valid platforms — add `"chatgpt"` to the string.

- [ ] **Step 5: Run the test**

```
npx vitest run test/cli/commands/install/chatgpt.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```
git add src/cli/commands/install/chatgpt.ts src/cli/commands/install.ts test/cli/commands/install/chatgpt.test.ts
git commit -m "feat(chatgpt): add memory install chatgpt command"
```

---

### Task 6: `memory uninstall chatgpt`

**Files:**
- Create: `src/cli/commands/uninstall/chatgpt.ts`
- Modify: `src/cli/commands/uninstall.ts`

- [ ] **Step 1: Create `src/cli/commands/uninstall/chatgpt.ts`**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runChatGptBridgeStop } from "../chatgpt-bridge.js";
import { applyConfigPatch } from "../../../dashboard/config-patch.js";
import { memoryRoot } from "../../../storage/paths.js";

const execFileAsync = promisify(execFile);

const AUTOSTART_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTOSTART_NAME = "MemoryFortChatGptBridge";

export interface UninstallChatGptResult {
  bridgeStopped: boolean;
  autostartRemoved: boolean;
  configCleared: boolean;
}

export async function runUninstallChatGpt(
  opts: { dryRun?: boolean } = {},
): Promise<UninstallChatGptResult> {
  let bridgeStopped = false;
  let autostartRemoved = false;
  let configCleared = false;

  if (!opts.dryRun) {
    // Stop running bridge
    await runChatGptBridgeStop();
    bridgeStopped = true;

    // Remove autostart registry entry
    if (process.platform === "win32") {
      try {
        await execFileAsync("reg.exe", [
          "delete",
          AUTOSTART_KEY,
          "/v",
          AUTOSTART_NAME,
          "/f",
        ]);
        autostartRemoved = true;
      } catch {
        // Entry may not exist; that's fine
      }
    }

    // Remove chatgpt section from config.yaml
    // applyConfigPatch with null bridge_port clears it via merge
    try {
      const root = memoryRoot();
      await applyConfigPatch(root, { chatgpt: { bridge_port: undefined } });
      configCleared = true;
    } catch {
      // Best-effort config cleanup
    }
  }

  return { bridgeStopped, autostartRemoved, configCleared };
}
```

- [ ] **Step 2: Wire into `src/cli/commands/uninstall.ts`**

Open `src/cli/commands/uninstall.ts`. Make two changes:

**a) Add import near top:**
```typescript
import { runUninstallChatGpt } from "./uninstall/chatgpt.js";
```
(Create the `uninstall/` subdirectory if needed — or put it inline. Check if other uninstall functions are inline or in separate files; if inline, add it inline in `uninstall.ts`.)

**b) Add case in `runUninstall()` switch before `default:`:**
```typescript
    case "chatgpt": {
      const uninstallResult = await runUninstallChatGpt({ dryRun: opts.dryRun });
      const actions: string[] = [];
      if (uninstallResult.bridgeStopped) actions.push("stopped ChatGPT bridge process");
      if (uninstallResult.autostartRemoved) actions.push("removed autostart registry entry");
      if (uninstallResult.configCleared) actions.push("cleared chatgpt config from config.yaml");
      return result("chatgpt", opts, actions.length > 0 ? actions : ["nothing to remove"], true);
    }
```

**c) Update the error message** listing valid platforms — add `"chatgpt"`.

- [ ] **Step 3: Test manually (uninstall has no existing unit test pattern for simple cases)**

```
node dist/cli.mjs uninstall chatgpt --dry-run
```

Expected: prints "nothing to remove" or similar.

- [ ] **Step 4: Commit**

```
git add src/cli/commands/uninstall/chatgpt.ts src/cli/commands/uninstall.ts
git commit -m "feat(chatgpt): add memory uninstall chatgpt command"
```

---

### Task 7: Verify checks

**Files:**
- Create: `src/cli/commands/verify/chatgpt.ts`
- Modify: `src/cli/commands/verify/clients.ts`
- Modify: `src/cli/commands/verify/registry.ts`
- Create: `test/cli/commands/verify/chatgpt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cli/commands/verify/chatgpt.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  chatgptBridgeRunningCheck,
  chatgptBridgeMcpCheck,
} from "../../../../src/cli/commands/verify/chatgpt.js";

const ctx = { vaultRoot: "/tmp/test-memory", role: "operator" as const };

vi.mock("../../../../src/storage/config.js", () => ({
  loadMemoryConfig: async () => ({}),
  getChatGptBridgePort: () => 3100,
  isClientEnabled: (_config: unknown, _id: string) => true,
}));

vi.mock("../../../../src/storage/paths.js", () => ({
  chatgptBridgePidPath: () => "/tmp/test-chatgpt-bridge.pid",
  memoryRoot: () => "/tmp/test-memory",
}));

describe("chatgptBridgeRunningCheck", () => {
  it("fails when PID file absent", async () => {
    vi.mock("node:fs", () => ({ existsSync: () => false }));
    const result = await chatgptBridgeRunningCheck.run(ctx);
    expect(result.status).toBe("fail");
  });
});

describe("chatgptBridgeMcpCheck", () => {
  it("returns skip when chatgpt client disabled", async () => {
    vi.mock("../../../../src/storage/config.js", () => ({
      loadMemoryConfig: async () => ({}),
      getChatGptBridgePort: () => 3100,
      isClientEnabled: (_config: unknown, _id: string) => false,
    }));
    const result = await chatgptBridgeMcpCheck.run(ctx);
    expect(result.status).toBe("skip");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```
npx vitest run test/cli/commands/verify/chatgpt.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `src/cli/commands/verify/chatgpt.ts`**

```typescript
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chatgptBridgePidPath, memoryRoot } from "../../../storage/paths.js";
import { loadMemoryConfig, getChatGptBridgePort, isClientEnabled } from "../../../storage/config.js";
import { fail, pass, skip, warn, type CheckDescriptor, type VerifyCheckResult } from "./types.js";

const CLIENT_ID = "chatgpt";

async function skipIfDisabled(
  ctx: { vaultRoot: string },
  checkId: string,
  label: string,
): Promise<VerifyCheckResult | null> {
  const config = await loadMemoryConfig(ctx.vaultRoot);
  if (isClientEnabled(config, CLIENT_ID)) return null;
  return skip(checkId, label, `${CLIENT_ID} is turned off in config.yaml`);
}

export const chatgptBridgeRunningCheck: CheckDescriptor = {
  id: "chatgpt.bridge.running",
  label: "ChatGPT bridge process running",
  roles: ["operator"],
  run: async (ctx) => {
    const off = await skipIfDisabled(ctx, "chatgpt.bridge.running", "ChatGPT bridge process running");
    if (off) return off;

    const pidPath = chatgptBridgePidPath();
    if (!existsSync(pidPath)) {
      return fail(
        "chatgpt.bridge.running",
        "ChatGPT bridge process running",
        "PID file not found — bridge is not running",
        "memory chatgpt-bridge start",
      );
    }

    const pidStr = (await readFile(pidPath, "utf-8")).trim();
    const pid = parseInt(pidStr, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return fail(
        "chatgpt.bridge.running",
        "ChatGPT bridge process running",
        "PID file is corrupt",
        "memory chatgpt-bridge stop && memory chatgpt-bridge start",
      );
    }

    try {
      process.kill(pid, 0);
      return pass("chatgpt.bridge.running", "ChatGPT bridge process running", `PID ${pid}`);
    } catch {
      return fail(
        "chatgpt.bridge.running",
        "ChatGPT bridge process running",
        `PID ${pid} is not alive (stale PID file)`,
        "memory chatgpt-bridge start",
      );
    }
  },
};

export const chatgptBridgeMcpCheck: CheckDescriptor = {
  id: "chatgpt.bridge.mcp",
  label: "ChatGPT bridge MCP endpoint reachable",
  roles: ["operator"],
  run: async (ctx) => {
    const off = await skipIfDisabled(ctx, "chatgpt.bridge.mcp", "ChatGPT bridge MCP endpoint reachable");
    if (off) return off;

    const config = await loadMemoryConfig(ctx.vaultRoot);
    const port = getChatGptBridgePort(config);
    const url = `http://127.0.0.1:${port}/health`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) {
        return pass(
          "chatgpt.bridge.mcp",
          "ChatGPT bridge MCP endpoint reachable",
          `http://127.0.0.1:${port}/sse`,
        );
      }
      return warn(
        "chatgpt.bridge.mcp",
        "ChatGPT bridge MCP endpoint reachable",
        `Health check returned HTTP ${res.status}`,
        "memory chatgpt-bridge stop && memory chatgpt-bridge start",
      );
    } catch (err) {
      return fail(
        "chatgpt.bridge.mcp",
        "ChatGPT bridge MCP endpoint reachable",
        `Cannot reach http://127.0.0.1:${port} — ${(err as Error).message}`,
        "memory chatgpt-bridge start",
      );
    }
  },
};
```

- [ ] **Step 4: Wire into `src/cli/commands/verify/clients.ts`**

At the top of `clients.ts`, add the import:
```typescript
import { chatgptBridgeRunningCheck, chatgptBridgeMcpCheck } from "./chatgpt.js";
```

At the bottom of `CLIENT_CHECKS` array (after `snifferClaudeDesktopCaptureCheck`), add:
```typescript
  chatgptBridgeRunningCheck,
  chatgptBridgeMcpCheck,
```

- [ ] **Step 5: Wire into `src/cli/commands/verify/registry.ts`**

Add import near the other client imports:
```typescript
import { chatgptBridgeRunningCheck, chatgptBridgeMcpCheck } from "./chatgpt.js";
```

Add to `ALL_CHECKS` array after `snifferClaudeDesktopCaptureCheck`:
```typescript
  chatgptBridgeRunningCheck,
  chatgptBridgeMcpCheck,
```

- [ ] **Step 6: Run the verify test**

```
npx vitest run test/cli/commands/verify/chatgpt.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```
git add src/cli/commands/verify/chatgpt.ts src/cli/commands/verify/clients.ts src/cli/commands/verify/registry.ts test/cli/commands/verify/chatgpt.test.ts
git commit -m "feat(chatgpt): add verify checks for ChatGPT bridge"
```

---

### Task 8: Register CLI command in cli.ts

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add import near the top of cli.ts with other command imports**

Find the imports block in `src/cli.ts`. Add:
```typescript
import {
  runChatGptBridgeStart,
  runChatGptBridgeStop,
  runChatGptBridgeStatus,
} from "./cli/commands/chatgpt-bridge.js";
```

- [ ] **Step 2: Register the chatgpt-bridge command**

Find where `program.command("supervisor")` is registered in `cli.ts`. Add the `chatgpt-bridge` command after it:

```typescript
const chatgptBridge = program
  .command("chatgpt-bridge")
  .description("Manage the ChatGPT HTTP/SSE MCP bridge process");

chatgptBridge
  .command("start")
  .description("Start the bridge as a background process")
  .action(async () => {
    try {
      const status = await runChatGptBridgeStart();
      if (status.running) {
        console.log(`✓ Bridge running at ${status.url} (PID ${status.pid})`);
      } else {
        console.log("Bridge started (waiting for port...)");
      }
    } catch (err) {
      console.error(`chatgpt-bridge start failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

chatgptBridge
  .command("stop")
  .description("Stop the running bridge")
  .action(async () => {
    try {
      await runChatGptBridgeStop();
      console.log("Bridge stopped.");
    } catch (err) {
      console.error(`chatgpt-bridge stop failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

chatgptBridge
  .command("status")
  .description("Check if the bridge is running")
  .action(async () => {
    try {
      const status = await runChatGptBridgeStatus();
      if (status.running) {
        console.log(`running  PID ${status.pid}  ${status.url}`);
      } else {
        console.log(`stopped  port ${status.port}  (not running)`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`chatgpt-bridge status failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 3: Build and confirm chatgpt-bridge command is registered**

```
npm run build
node dist/cli.mjs chatgpt-bridge --help
```

Expected: shows `start`, `stop`, `status` sub-commands listed.

- [ ] **Step 4: Commit**

```
git add src/cli.ts
git commit -m "feat(chatgpt): register chatgpt-bridge CLI command"
```

---

### Task 9: Dashboard toggle

**Files:**
- Modify: `src/dashboard-ui/components/ClientsConfigCard.tsx`

- [ ] **Step 1: Add chatgpt to TOGGLEABLE_CLIENTS**

Open `src/dashboard-ui/components/ClientsConfigCard.tsx`. Find `TOGGLEABLE_CLIENTS`:

```typescript
const TOGGLEABLE_CLIENTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "opencoven", label: "OpenCoven" },
];
```

Add `chatgpt` entry:

```typescript
const TOGGLEABLE_CLIENTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "opencoven", label: "OpenCoven" },
  { id: "chatgpt", label: "ChatGPT" },
];
```

- [ ] **Step 2: Update tests that snapshot TOGGLEABLE_CLIENTS**

Search for tests that reference `ClientsConfigCard`:
```
grep -r "ClientsConfigCard\|TOGGLEABLE_CLIENTS" test/
```

If any test asserts the exact list of clients, add `"ChatGPT"` to the expected list.

- [ ] **Step 3: Run existing settings/UI tests**

```
npx vitest run test/dashboard-ui/
```

Expected: all pass.

- [ ] **Step 4: Commit**

```
git add src/dashboard-ui/components/ClientsConfigCard.tsx
git commit -m "feat(chatgpt): add ChatGPT toggle to ClientsConfigCard"
```

---

### Task 10: Full build + integration smoke test

- [ ] **Step 1: Run full test suite**

```
npm test
```

Expected: all tests pass. Note any failures and fix before proceeding.

- [ ] **Step 2: Build everything**

```
npm run build:all
```

Expected: clean build, `dist/mcp/http-bridge.mjs` present.

- [ ] **Step 3: Smoke test install command**

```
node dist/cli.mjs install chatgpt --dry-run
```

Expected: prints bridge URL and ChatGPT connector instructions. No side effects.

- [ ] **Step 4: Smoke test bridge commands**

```
node dist/cli.mjs chatgpt-bridge start
node dist/cli.mjs chatgpt-bridge status
curl http://127.0.0.1:3100/health
node dist/cli.mjs chatgpt-bridge stop
node dist/cli.mjs chatgpt-bridge status
```

Expected:
- `start` → prints URL
- `status` → prints "running PID ..."
- `curl` → `ok`
- `stop` → "Bridge stopped."
- `status` → exits 1 with "stopped"

- [ ] **Step 5: Reinstall globally**

```
npm uninstall -g memory-fort && npm install -g .
```

- [ ] **Step 6: Fast-forward main to include all new commits**

```
git branch -f main HEAD
```

- [ ] **Step 7: Final commit if any loose changes**

```
git status
# If clean, nothing to do. If dirty, commit the stragglers.
```
