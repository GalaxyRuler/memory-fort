import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import yaml from "js-yaml";

import { getChatGptBridgePort, isClientEnabled, type MemoryConfig } from "../storage/config.js";
import {
  claudeDesktopConfigPath,
  configPath as memoryConfigPath,
  memoryRoot,
} from "../storage/paths.js";
import { loadBridgeTlsCert } from "../mcp/tls.js";
import { isClaudeCodePluginEnabled } from "../cli/commands/install/claude-code.js";
import { readOpenCodeReadiness } from "../cli/commands/install/opencode.js";
import { readOpenCovenReadiness } from "../cli/commands/install/opencoven.js";
import { vscodeMcpConfigPath } from "../cli/commands/install/vscode.js";

export type ClientName =
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "antigravity"
  | "antigravity-ide"
  | "chatgpt"
  | "hermes"
  | "pi"
  | "openclaw"
  | "opencoven"
  | "opencode"
  | "vscode";

export type ClientInstallation = "missing" | "stale" | "installed";
export type ClientHealth = "unknown" | "healthy" | "unhealthy";

/**
 * The single truth for every surface (CLI, dashboard, and Electron bootstrap).
 * Installation and health deliberately remain separate: a config file does not
 * prove that its referenced hook or MCP process is usable.
 */
export interface ClientIntegrationStatus {
  client: ClientName;
  captureEnabled: boolean;
  installation: ClientInstallation;
  health: ClientHealth;
  lastCheckedAt: string | null;
  evidence: string[];
  configPath?: string;
}

export const CLIENTS: ClientName[] = [
  "claude-code", "claude-desktop", "codex", "antigravity", "antigravity-ide",
  "chatgpt", "hermes", "pi", "openclaw", "opencoven", "opencode", "vscode",
];

export interface McpProbeCommand {
  command: string;
  args: string[];
}

/** Exact tool surface registered by the shipped stdio MCP server. */
export const MEMORY_FORT_MCP_TOOLS = [
  "log_observation",
  "read_page",
  "list_pages",
  "search",
  "search_capabilities",
] as const;

export interface ClientStatusOptions {
  /** Expensive protocol checks are opt-in for callers that only need installation evidence. */
  probeMcp?: boolean;
  now?: () => Date;
  probeMcpCommand?: (command: McpProbeCommand) => Promise<ClientHealth>;
  probeChatGpt?: (port: number) => Promise<ClientHealth>;
}

export function classifyClientPresentation(status: ClientIntegrationStatus):
  | "Off"
  | "Not installed"
  | "Needs repair"
  | "Installed — health unknown"
  | "Healthy"
  | "Unhealthy" {
  if (!status.captureEnabled) return "Off";
  if (status.installation === "missing") return "Not installed";
  if (status.installation === "stale") return "Needs repair";
  if (status.health === "healthy") return "Healthy";
  if (status.health === "unhealthy") return "Unhealthy";
  return "Installed — health unknown";
}

export async function getClientIntegrationStatuses(
  opts: ClientStatusOptions = {},
): Promise<ClientIntegrationStatus[]> {
  // Status reads are intentionally non-mutating: unlike broad config loading,
  // a malformed client config must not create diagnostics during Electron's
  // first-run inventory scan.
  const config = await readClientConfigReadOnly();
  const enabled = (client: ClientName) => isClientEnabled(config, client === "antigravity-ide" ? "antigravity" : client);
  const antigravity = await readAntigravityStatus(enabled("antigravity"));
  const statuses: ClientIntegrationStatus[] = [
    await readClaudeCodeStatus(enabled("claude-code")),
    await readClaudeDesktopStatus(enabled("claude-desktop")),
    await readCodexStatus(enabled("codex")),
    antigravity,
    { ...antigravity, client: "antigravity-ide", captureEnabled: enabled("antigravity-ide") },
    await readChatGptStatus(enabled("chatgpt"), opts, config),
    await readHookStatus("hermes", enabled("hermes"), join(process.env["MEMORY_HERMES_DIR"] ?? join(homedir(), ".hermes"), "config.yaml"), "mcp-server.mjs"),
    await readHookStatus("pi", enabled("pi"), join(process.env["MEMORY_PI_DIR"] ?? join(homedir(), ".pi"), "config.yaml"), "session-start.mjs"),
    await readMcpConfigStatus("openclaw", enabled("openclaw"), join(process.env["MEMORY_OPENCLAW_DIR"] ?? join(homedir(), ".openclaw"), "openclaw.json"), "mcpServers"),
    await readOpenCovenStatus(enabled("opencoven")),
    await readOpenCodeStatus(enabled("opencode"), opts),
    await readMcpConfigStatus("vscode", enabled("vscode"), vscodeMcpConfigPath(), "servers"),
  ];
  if (!opts.probeMcp) return statuses;
  return Promise.all(statuses.map((status) => probeConfiguredMcp(status, opts)));
}

function makeStatus(
  client: ClientName,
  captureEnabled: boolean,
  installation: ClientInstallation,
  evidence: string[],
  configPath?: string,
): ClientIntegrationStatus {
  return { client, captureEnabled, installation, health: "unknown", lastCheckedAt: null, evidence, configPath };
}

async function readClaudeCodeStatus(captureEnabled: boolean): Promise<ClientIntegrationStatus> {
  const pluginRoot = join(memoryRoot(), "claude-code-plugin");
  const manifest = join(pluginRoot, ".claude-plugin", "plugin.json");
  const mcpConfig = join(pluginRoot, ".mcp.json");
  if (!existsSync(manifest) || !existsSync(mcpConfig)) {
    return makeStatus("claude-code", captureEnabled, "missing", ["not installed: plugin manifest or MCP config missing"], mcpConfig);
  }
  if (!await isRegularFile(join(pluginRoot, "scripts", "mcp-server.mjs"))) {
    return makeStatus("claude-code", captureEnabled, "stale", ["installed but scripts link is stale"], mcpConfig);
  }
  if (!await isClaudeCodePluginEnabled()) {
    return makeStatus("claude-code", captureEnabled, "stale", ["plugin installed but not enabled in Claude Code settings"], mcpConfig);
  }
  return makeStatus("claude-code", captureEnabled, "installed", ["installed and enabled"], mcpConfig);
}

async function readClaudeDesktopStatus(captureEnabled: boolean): Promise<ClientIntegrationStatus> {
  const path = claudeDesktopConfigPath();
  const ok = await jsonHasServer(path, "mcpServers");
  return makeStatus("claude-desktop", captureEnabled, ok ? "installed" : existsSync(path) ? "stale" : "missing", [ok ? "installed" : existsSync(path) ? "installed but memory entry missing or invalid" : "not installed"], path);
}

async function readCodexStatus(captureEnabled: boolean): Promise<ClientIntegrationStatus> {
  const dir = process.env["MEMORY_CODEX_DIR"] ?? join(homedir(), ".codex");
  const path = join(dir, "config.toml");
  if (!existsSync(path)) return makeStatus("codex", captureEnabled, "missing", ["config.toml is missing"], path);
  const raw = await readFile(path, "utf-8");
  const block = raw.includes("[mcp_servers.memory]") && raw.includes("mcp-server.mjs");
  if (!block) return makeStatus("codex", captureEnabled, "stale", ["installed but memory MCP block is stale"], path);
  const launcherRoot = join(memoryRoot(), "claude-code-plugin", "scripts");
  const scriptNames = ["mcp-server.mjs", "session-start.mjs", "prompt-submit.mjs", "post-tool-use.mjs", "pre-compact.mjs", "session-end.mjs"];
  const referenced = scriptNames.filter((name) => raw.includes(name)).map((name) => join(launcherRoot, name));
  if (!await allRegularFiles(referenced)) return makeStatus("codex", captureEnabled, "stale", ["installed but configured hook or MCP executable is missing"], path);
  return makeStatus("codex", captureEnabled, "installed", ["installed"], path);
}

async function readAntigravityStatus(captureEnabled: boolean): Promise<ClientIntegrationStatus> {
  const path = join(process.env["MEMORY_ANTIGRAVITY_DIR"] ?? join(homedir(), ".gemini", "antigravity"), "mcp_config.json");
  const ok = await jsonHasServer(path, "mcpServers");
  return makeStatus("antigravity", captureEnabled, ok ? "installed" : existsSync(path) ? "stale" : "missing", [ok ? "installed (shared workspace/IDE config)" : existsSync(path) ? "installed but memory entry missing or invalid" : "not installed"], path);
}

async function readChatGptStatus(
  captureEnabled: boolean,
  opts: ClientStatusOptions,
  config: MemoryConfig,
): Promise<ClientIntegrationStatus> {
  const port = getChatGptBridgePort(config);
  if (!captureEnabled) return makeStatus("chatgpt", false, "missing", ["disabled in config.yaml"], memoryConfigPath());
  const health = await (opts.probeChatGpt ?? probeChatGptBridge)(port);
  const checkedAt = (opts.now ?? (() => new Date()))().toISOString();
  if (health !== "healthy") {
    return { ...makeStatus("chatgpt", true, "installed", ["installed bridge config but the bounded endpoint probe failed; PID files are not health evidence"], memoryConfigPath()), health: "unhealthy", lastCheckedAt: checkedAt };
  }
  return { ...makeStatus("chatgpt", true, "installed", [`bridge endpoint responded on localhost:${port}`], memoryConfigPath()), health: "healthy", lastCheckedAt: checkedAt };
}

async function readClientConfigReadOnly(): Promise<MemoryConfig> {
  try {
    const parsed = yaml.load(await readFile(memoryConfigPath(), "utf-8"), { schema: yaml.JSON_SCHEMA });
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as MemoryConfig
      : {};
  } catch {
    return {};
  }
}

async function readHookStatus(client: "hermes" | "pi", captureEnabled: boolean, path: string, expectedScript: string): Promise<ClientIntegrationStatus> {
  if (!existsSync(path)) return makeStatus(client, captureEnabled, "missing", ["not installed"], path);
  const raw = await readFile(path, "utf-8");
  const script = join(memoryRoot(), "hooks", expectedScript);
  const configured = raw.includes("# === BEGIN memory-system") && raw.includes(expectedScript);
  if (!configured || !await isRegularFile(script)) return makeStatus(client, captureEnabled, "stale", [client === "pi" ? "installed but memory hooks block is stale" : "installed but memory block is stale"], path);
  return makeStatus(client, captureEnabled, "installed", [client === "pi" ? "installed (hooks; MCP skipped)" : "installed"], path);
}

async function readMcpConfigStatus(client: "openclaw" | "vscode", captureEnabled: boolean, path: string, map: "mcpServers" | "servers"): Promise<ClientIntegrationStatus> {
  const ok = await jsonHasServer(path, map);
  return makeStatus(client, captureEnabled, ok ? "installed" : existsSync(path) ? "stale" : "missing", [ok ? (client === "vscode" ? "installed (user profile mcp.json)" : "installed") : existsSync(path) ? "installed but memory server missing or invalid" : "not installed"], path);
}

async function readOpenCovenStatus(captureEnabled: boolean): Promise<ClientIntegrationStatus> {
  const readiness = await readOpenCovenReadiness();
  return makeStatus("opencoven", captureEnabled, readiness.state, [readiness.detail], readiness.socketPath);
}

async function readOpenCodeStatus(captureEnabled: boolean, _opts: ClientStatusOptions): Promise<ClientIntegrationStatus> {
  const readiness = await readOpenCodeReadiness();
  const installed = readiness.config.ok && readiness.plugin.ok;
  const any = readiness.config.exists || readiness.plugin.exists;
  return makeStatus("opencode", captureEnabled, installed ? "installed" : any ? "stale" : "missing", [installed ? "installed" : any ? "installed but memory MCP or plugin file is missing or stale" : "not installed"], readiness.configPath);
}

async function probeConfiguredMcp(status: ClientIntegrationStatus, opts: ClientStatusOptions): Promise<ClientIntegrationStatus> {
  if (!status.captureEnabled || status.installation !== "installed" || !hasMcp(status.client)) return status;
  const script = status.client === "opencode" ? join(memoryRoot(), "hooks", "mcp-server.mjs") : join(memoryRoot(), "claude-code-plugin", "scripts", "mcp-server.mjs");
  if (!await isRegularFile(script)) return { ...status, installation: "stale", health: "unknown", evidence: [...status.evidence, "configured MCP launcher is missing"] };
  const health = await (opts.probeMcpCommand ?? runBoundedMcpProbe)({ command: "node", args: [script] });
  return { ...status, health, lastCheckedAt: (opts.now ?? (() => new Date()))().toISOString(), evidence: [...status.evidence, health === "healthy" ? "bounded MCP initialize + tools/list probe passed" : "bounded MCP initialize + tools/list probe failed"] };
}

function hasMcp(client: ClientName): boolean {
  return !["pi", "opencoven", "chatgpt"].includes(client);
}

export async function runBoundedMcpProbe(command: McpProbeCommand, timeoutMs = 2_000): Promise<ClientHealth> {
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let done = false;
    let buffer = "";
    const finish = (value: ClientHealth) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish("unhealthy"), timeoutMs);
    child.once("error", () => finish("unhealthy"));
    child.once("exit", () => { if (!done) finish("unhealthy"); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part: string) => {
      buffer += part;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name?: string }> } };
          if (message.id === 1) {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
          }
          if (message.id === 2) {
            const tools = new Set((message.result?.tools ?? []).map((tool) => tool.name));
            finish(MEMORY_FORT_MCP_TOOLS.every((tool) => tools.has(tool)) ? "healthy" : "unhealthy");
          }
        } catch { /* wait for the next complete protocol line */ }
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "memory-fort-status", version: "1" } } })}\n`);
  });
}

async function probeChatGptBridge(port: number): Promise<ClientHealth> {
  try {
    const tls = await loadBridgeTlsCert();
    if (!tls) {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      return response.status === 200 ? "healthy" : "unhealthy";
    }
    const status = await new Promise<number>((resolve, reject) => {
      const request = https.get({ hostname: "127.0.0.1", port, path: "/health", ca: tls.cert, timeout: 2_000 }, (response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      request.once("error", reject);
      request.once("timeout", () => request.destroy(new Error("timeout")));
    });
    return status === 200 ? "healthy" : "unhealthy";
  } catch {
    return "unhealthy";
  }
}

async function jsonHasServer(path: string, map: "mcpServers" | "servers"): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    const servers = parsed[map];
    return typeof servers === "object" && servers !== null && typeof (servers as Record<string, unknown>)["memory"] === "object" && (servers as Record<string, unknown>)["memory"] !== null;
  } catch { return false; }
}

async function isRegularFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function allRegularFiles(paths: string[]): Promise<boolean> {
  return (await Promise.all(paths.map(isRegularFile))).every(Boolean);
}
