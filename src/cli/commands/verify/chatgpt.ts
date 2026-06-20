import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { chatgptBridgePidPath } from "../../../storage/paths.js";
import { loadMemoryConfig, getChatGptBridgePort, isClientEnabled } from "../../../storage/config.js";
import { loadBridgeTlsCert } from "../../../mcp/tls.js";
import { fail, pass, skip, warn, type CheckDescriptor } from "./types.js";

const CLIENT_ID = "chatgpt";

/**
 * ChatGPT bridge is opt-in: the shared client catalog defaults it off until
 * install or settings explicitly set `clients.chatgpt: true`.
 */
function isChatGptBridgeEnabled(config: { clients?: Record<string, boolean> }): boolean {
  return isClientEnabled(config, CLIENT_ID);
}

export const chatgptBridgeRunningCheck: CheckDescriptor = {
  id: "chatgpt.bridge.running",
  label: "ChatGPT bridge process running",
  roles: ["operator"],
  run: async (ctx) => {
    const config = await loadMemoryConfig(ctx.vaultRoot);
    if (!isChatGptBridgeEnabled(config)) {
      return skip("chatgpt.bridge.running", "ChatGPT bridge process running", `${CLIENT_ID} bridge not enabled in config.yaml (set clients.chatgpt: true to enable)`);
    }

    const pidPath = chatgptBridgePidPath();
    if (!existsSync(pidPath)) {
      return fail(
        "chatgpt.bridge.running",
        "ChatGPT bridge process running",
        "memory chatgpt-bridge start",
        "PID file not found — bridge is not running",
      );
    }

    const pidStr = (await readFile(pidPath, "utf-8")).trim();
    const pid = parseInt(pidStr, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return fail(
        "chatgpt.bridge.running",
        "ChatGPT bridge process running",
        "memory chatgpt-bridge stop && memory chatgpt-bridge start",
        "PID file is corrupt",
      );
    }

    try {
      process.kill(pid, 0);
      return pass("chatgpt.bridge.running", "ChatGPT bridge process running", `PID ${pid}`);
    } catch {
      return fail(
        "chatgpt.bridge.running",
        "ChatGPT bridge process running",
        "memory chatgpt-bridge start",
        `PID ${pid} is not alive (stale PID file)`,
      );
    }
  },
};

export const chatgptBridgeMcpCheck: CheckDescriptor = {
  id: "chatgpt.bridge.mcp",
  label: "ChatGPT bridge MCP endpoint reachable",
  roles: ["operator"],
  run: async (ctx) => {
    const config = await loadMemoryConfig(ctx.vaultRoot);
    if (!isChatGptBridgeEnabled(config)) {
      return skip("chatgpt.bridge.mcp", "ChatGPT bridge MCP endpoint reachable", `${CLIENT_ID} bridge not enabled in config.yaml (set clients.chatgpt: true to enable)`);
    }

    const tls = await loadBridgeTlsCert();
    const scheme = tls ? "https" : "http";
    const port = getChatGptBridgePort(config);
    const url = `${scheme}://127.0.0.1:${port}/health`;

    try {
      const status = tls
        ? await getHttpsHealthStatus(port, tls.cert)
        : await getHttpHealthStatus(url);
      if (status === 200) {
        return pass("chatgpt.bridge.mcp", "ChatGPT bridge MCP endpoint reachable", `${scheme}://localhost:${port}/sse`);
      }
      return warn(
        "chatgpt.bridge.mcp",
        "ChatGPT bridge MCP endpoint reachable",
        `Health check returned HTTP ${status}`,
        "memory chatgpt-bridge stop && memory chatgpt-bridge start",
      );
    } catch (err) {
      return fail(
        "chatgpt.bridge.mcp",
        "ChatGPT bridge MCP endpoint reachable",
        "memory chatgpt-bridge start",
        `Cannot reach ${scheme}://localhost:${port} - ${(err as Error).message}`,
      );
    }
  },
};

async function getHttpHealthStatus(url: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return res.status;
}

async function getHttpsHealthStatus(port: number, ca: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = https.get(
      { hostname: "127.0.0.1", port, path: "/health", ca, timeout: 2000 },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}
