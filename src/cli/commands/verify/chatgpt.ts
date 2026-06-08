import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chatgptBridgePidPath } from "../../../storage/paths.js";
import { loadMemoryConfig, getChatGptBridgePort, isClientEnabled } from "../../../storage/config.js";
import { fail, pass, skip, warn, type CheckDescriptor } from "./types.js";

const CLIENT_ID = "chatgpt";

export const chatgptBridgeRunningCheck: CheckDescriptor = {
  id: "chatgpt.bridge.running",
  label: "ChatGPT bridge process running",
  roles: ["operator"],
  run: async (ctx) => {
    const config = await loadMemoryConfig(ctx.vaultRoot);
    if (!isClientEnabled(config, CLIENT_ID)) {
      return skip("chatgpt.bridge.running", "ChatGPT bridge process running", `${CLIENT_ID} is turned off in config.yaml`);
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
    if (!isClientEnabled(config, CLIENT_ID)) {
      return skip("chatgpt.bridge.mcp", "ChatGPT bridge MCP endpoint reachable", `${CLIENT_ID} is turned off in config.yaml`);
    }

    const port = getChatGptBridgePort(config);
    const url = `http://127.0.0.1:${port}/health`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) {
        return pass("chatgpt.bridge.mcp", "ChatGPT bridge MCP endpoint reachable", `http://127.0.0.1:${port}/sse`);
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
        "memory chatgpt-bridge start",
        `Cannot reach http://127.0.0.1:${port} — ${(err as Error).message}`,
      );
    }
  },
};
