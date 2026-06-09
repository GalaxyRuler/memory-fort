import { existsSync } from "node:fs";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatgptBridgePidPath, memoryRoot } from "../../storage/paths.js";
import { loadMemoryConfig, getChatGptBridgePort } from "../../storage/config.js";
import { loadBridgeTlsCert } from "../../mcp/tls.js";

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
  const tls = await loadBridgeTlsCert();
  const scheme = tls ? "https" : "http";
  const url = `${scheme}://localhost:${port}/sse`;

  if (!existsSync(pidPath)) {
    return { running: false, pid: null, port, url };
  }

  const pidStr = (await readFile(pidPath, "utf-8")).trim();
  const pid = parseInt(pidStr, 10);

  if (!Number.isInteger(pid) || pid <= 0) {
    return { running: false, pid: null, port, url };
  }

  const alive = isProcessAlive(pid);
  if (!alive) {
    await unlink(pidPath).catch(() => undefined);
    return { running: false, pid: null, port, url };
  }

  return { running: true, pid, port, url };
}

export async function runChatGptBridgeStart(): Promise<ChatGptBridgeStatus> {
  const config = await loadMemoryConfig(memoryRoot());
  const port = getChatGptBridgePort(config);

  const current = await runChatGptBridgeStatus();
  if (current.running) {
    return current;
  }

  // cli.mjs is bundled at dist/cli.mjs; http-bridge lives at dist/mcp/http-bridge.mjs
  const __dirname = fileURLToPath(new URL(".", import.meta.url));
  const bridgePath = join(__dirname, "mcp", "http-bridge.mjs");

  const child = spawn(process.execPath, [bridgePath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MEMORY_BRIDGE_PORT: String(port) },
  });
  child.unref();

  if (child.pid === undefined) {
    throw new Error("Failed to spawn bridge process — child.pid is undefined");
  }

  // Note: no lock — concurrent starts are not expected for a personal tool
  const pidPath = chatgptBridgePidPath();
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(child.pid), "utf-8");

  try {
    await waitForPort(port, 15000);
  } catch (err) {
    // Bridge didn't come up — clean up stale PID file
    await unlink(pidPath).catch(() => undefined);
    throw err;
  }

  const tls = await loadBridgeTlsCert();
  const scheme = tls ? "https" : "http";
  return { running: true, pid: child.pid, port, url: `${scheme}://localhost:${port}/sse` };
}

export async function runChatGptBridgeStop(): Promise<void> {
  const pidPath = chatgptBridgePidPath();

  if (!existsSync(pidPath)) {
    return;
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
  const tls = await loadBridgeTlsCert();
  while (Date.now() < deadline) {
    if (tls && await checkHttpsHealth(port, tls.cert)) return;
    if (await checkHttpHealth(port)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Bridge did not start within ${timeoutMs}ms on port ${port}`);
}

async function checkHttpsHealth(port: number, ca: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = https.get(
      { hostname: "127.0.0.1", port, path: "/health", ca, timeout: 500 },
      (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function checkHttpHealth(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/health", timeout: 500 },
      (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}
