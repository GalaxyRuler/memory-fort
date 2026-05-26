import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  claudeDesktopConfigPath,
  memoryRoot,
} from "../../storage/paths.js";
import { isClaudeCodePluginEnabled } from "./install/claude-code.js";
import { vscodeMcpConfigPath } from "./install/vscode.js";

export type ClientName =
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "antigravity"
  | "antigravity-ide"
  | "vscode";

export type ClientInstallState = "installed" | "stale" | "missing";

export interface ClientStatus {
  client: ClientName;
  state: ClientInstallState;
  detail: string;
  configPath?: string;
}

export const CLIENTS: ClientName[] = [
  "claude-code",
  "claude-desktop",
  "codex",
  "antigravity",
  "antigravity-ide",
  "vscode",
];

export async function getClientStatuses(): Promise<ClientStatus[]> {
  const antigravity = await readAntigravityStatus("antigravity");
  return [
    await readClaudeCodeStatus(),
    await readClaudeDesktopStatus(),
    await readCodexStatus(),
    antigravity,
    { ...antigravity, client: "antigravity-ide" },
    await readVsCodeStatus(),
  ];
}

export function formatClientStatus(status: ClientStatus): string {
  const marker =
    status.state === "installed" ? "✓" : status.state === "stale" ? "⚠" : "✗";
  return `${marker} ${status.client.padEnd(18)} ${status.detail}`;
}

async function readClaudeCodeStatus(): Promise<ClientStatus> {
  const pluginRoot = join(memoryRoot(), "claude-code-plugin");
  const manifest = join(pluginRoot, ".claude-plugin", "plugin.json");
  const mcpConfig = join(pluginRoot, ".mcp.json");
  const scripts = join(pluginRoot, "scripts", "mcp-server.mjs");
  if (!existsSync(manifest) || !existsSync(mcpConfig)) {
    return {
      client: "claude-code",
      state: "missing",
      detail: "not installed: plugin manifest or MCP config missing",
      configPath: mcpConfig,
    };
  }
  if (!existsSync(scripts)) {
    return {
      client: "claude-code",
      state: "stale",
      detail: "installed but scripts link is stale",
      configPath: mcpConfig,
    };
  }
  const enabled = await isClaudeCodePluginEnabled();
  if (!enabled) {
    return {
      client: "claude-code",
      state: "stale",
      detail: "plugin installed but not enabled in Claude Code settings",
      configPath: mcpConfig,
    };
  }
  return {
    client: "claude-code",
    state: "installed",
    detail: "installed and enabled",
    configPath: mcpConfig,
  };
}

async function readClaudeDesktopStatus(): Promise<ClientStatus> {
  const configPath = claudeDesktopConfigPath();
  const ok = await jsonHasServer(configPath, "mcpServers");
  return ok
    ? {
        client: "claude-desktop",
        state: "installed",
        detail: "installed",
        configPath,
      }
    : {
        client: "claude-desktop",
        state: existsSync(configPath) ? "stale" : "missing",
        detail: existsSync(configPath)
          ? "installed but memory entry missing or invalid"
          : "not installed",
        configPath,
      };
}

async function readCodexStatus(): Promise<ClientStatus> {
  const dir = process.env["MEMORY_CODEX_DIR"] ?? join(homedir(), ".codex");
  const configPath = join(dir, "config.toml");
  if (!existsSync(configPath)) {
    return { client: "codex", state: "missing", detail: "not installed", configPath };
  }
  const raw = await readFile(configPath, "utf-8");
  const ok = raw.includes("[mcp_servers.memory]") && raw.includes("mcp-server.mjs");
  return {
    client: "codex",
    state: ok ? "installed" : "stale",
    detail: ok ? "installed" : "installed but memory MCP block is stale",
    configPath,
  };
}

async function readAntigravityStatus(client: ClientName): Promise<ClientStatus> {
  const dir =
    process.env["MEMORY_ANTIGRAVITY_DIR"] ??
    join(homedir(), ".gemini", "antigravity");
  const configPath = join(dir, "mcp_config.json");
  const ok = await jsonHasServer(configPath, "mcpServers");
  return {
    client,
    state: ok ? "installed" : existsSync(configPath) ? "stale" : "missing",
    detail: ok
      ? "installed (shared workspace/IDE config)"
      : existsSync(configPath)
        ? "installed but memory entry missing or invalid"
        : "not installed",
    configPath,
  };
}

async function readVsCodeStatus(): Promise<ClientStatus> {
  const configPath = vscodeMcpConfigPath();
  const ok = await jsonHasServer(configPath, "servers");
  return {
    client: "vscode",
    state: ok ? "installed" : existsSync(configPath) ? "stale" : "missing",
    detail: ok
      ? "installed (user profile mcp.json)"
      : existsSync(configPath)
        ? "installed but memory server missing or invalid"
        : "not installed",
    configPath,
  };
}

async function jsonHasServer(
  configPath: string,
  serverMapKey: "mcpServers" | "servers",
): Promise<boolean> {
  if (!existsSync(configPath)) return false;
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const servers = parsed[serverMapKey];
    if (typeof servers !== "object" || servers === null) return false;
    const memory = (servers as Record<string, unknown>)["memory"];
    return typeof memory === "object" && memory !== null;
  } catch {
    return false;
  }
}
