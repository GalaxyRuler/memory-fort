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
    await unlink(pidPath).catch(() => undefined);
    return { running: false, pid: null, port, url: `http://127.0.0.1:${port}/sse` };
  }

  return { running: true, pid, port, url: `http://127.0.0.1:${port}/sse` };
}

export async function runChatGptBridgeStart(): Promise<ChatGptBridgeStatus> {
  const config = await loadMemoryConfig(memoryRoot());
  const port = getChatGptBridgePort(config);

  const current = await runChatGptBridgeStatus();
  if (current.running) {
    return current;
  }

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

  // Note: no lock — concurrent starts are not expected for a personal tool
  const pidPath = chatgptBridgePidPath();
  await writeFile(pidPath, String(child.pid), "utf-8");

  try {
    await waitForPort(port, 5000);
  } catch (err) {
    // Bridge didn't come up — clean up stale PID file
    await unlink(pidPath).catch(() => undefined);
    throw err;
  }

  return { running: true, pid: child.pid, port, url: `http://127.0.0.1:${port}/sse` };
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
