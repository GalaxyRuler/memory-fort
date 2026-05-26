import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeDesktopConfigPath,
  formatIsoDate,
} from "../../../storage/paths.js";
import {
  isClaudeCodePluginEnabled,
} from "../install/claude-code.js";
import { vscodeMcpConfigPath } from "../install/vscode.js";
import { fail, pass, warn, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function checkClients(
  ctx: VerifyCheckContext,
): Promise<VerifyCheckResult[]> {
  const [
    claudeEnabled,
    claudeCapture,
    codexConfig,
    codexCapture,
    antigravityConfig,
    antigravityCapture,
    vscodeConfig,
    claudeDesktopConfig,
  ] = await Promise.all([
    checkClaudeCodeEnabled(),
    checkRecentCapture(ctx, ["claude-code-", "claude-"], "client.claude-code.capture", "claude-code"),
    checkCodexConfig(),
    checkRecentCapture(ctx, ["codex-"], "client.codex.capture", "codex"),
    checkJsonServer(
      antigravityConfigPath(),
      "mcpServers",
      "client.antigravity.config",
      "antigravity MCP entry present (informational)",
      "run `memory connect antigravity`",
      true,
    ),
    checkAnyCapture(ctx, ["antigravity-"], "client.antigravity.capture"),
    checkJsonServer(
      vscodeMcpConfigPath(),
      "servers",
      "client.vscode.config",
      "vscode MCP entry present",
      "run `memory connect vscode`",
    ),
    checkJsonServer(
      claudeDesktopConfigPath(),
      "mcpServers",
      "client.claude-desktop.config",
      "claude-desktop MCP entry present",
      "run `memory connect claude-desktop`",
    ),
  ]);

  return [
    claudeEnabled,
    claudeCapture,
    codexConfig,
    codexCapture,
    antigravityConfig,
    antigravityCapture,
    vscodeConfig,
    claudeDesktopConfig,
  ];
}

async function checkClaudeCodeEnabled(): Promise<VerifyCheckResult> {
  const enabled = await isClaudeCodePluginEnabled();
  return enabled
    ? pass("client.claude-code.enabled", "claude-code plugin enabled")
    : fail(
        "client.claude-code.enabled",
        "claude-code plugin enabled",
        "run `memory connect claude-code`",
      );
}

async function checkCodexConfig(): Promise<VerifyCheckResult> {
  const configPath = join(
    process.env["MEMORY_CODEX_DIR"] ?? join(homedir(), ".codex"),
    "config.toml",
  );
  if (!existsSync(configPath)) {
    return fail(
      "client.codex.config",
      "codex MCP block present",
      "run `memory connect codex`",
    );
  }
  const raw = await readFile(configPath, "utf-8");
  const ok = raw.includes("[mcp_servers.memory]") && raw.includes("mcp-server.mjs");
  return ok
    ? pass("client.codex.config", "codex MCP block present")
    : fail(
        "client.codex.config",
        "codex MCP block present",
        "run `memory connect codex`",
      );
}

async function checkJsonServer(
  configPath: string,
  serverKey: "mcpServers" | "servers",
  id: string,
  label: string,
  fix: string,
  informational = false,
): Promise<VerifyCheckResult> {
  const ok = await jsonHasMemoryServer(configPath, serverKey);
  if (ok) return pass(id, label);
  return informational
    ? warn(id, label, `missing at ${configPath}`, fix)
    : fail(id, label, fix, `missing at ${configPath}`);
}

async function jsonHasMemoryServer(
  configPath: string,
  serverKey: "mcpServers" | "servers",
): Promise<boolean> {
  if (!existsSync(configPath)) return false;
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const servers = parsed[serverKey];
    if (typeof servers !== "object" || servers === null) return false;
    const memory = (servers as Record<string, unknown>)["memory"];
    return typeof memory === "object" && memory !== null;
  } catch {
    return false;
  }
}

async function checkRecentCapture(
  ctx: VerifyCheckContext,
  prefixes: string[],
  id: string,
  label: string,
): Promise<VerifyCheckResult> {
  const count = await countRecentCaptures(ctx, prefixes, true);
  return count > 0
    ? pass(id, `${label} captures today`, `${count} captures today`)
    : warn(
        id,
        `${label} captures today`,
        "no capture file from the last 24h",
      );
}

async function checkAnyCapture(
  ctx: VerifyCheckContext,
  prefixes: string[],
  id: string,
): Promise<VerifyCheckResult> {
  const count = await countRecentCaptures(ctx, prefixes, false);
  return count > 0
    ? pass(id, "antigravity captures present (informational)", `${count} captures`)
    : warn(
        id,
        "antigravity captures rely on manual MCP tool calls",
        "no antigravity captures found",
      );
}

async function countRecentCaptures(
  ctx: VerifyCheckContext,
  prefixes: string[],
  todayOnly: boolean,
): Promise<number> {
  const rawRoot = join(ctx.vaultRoot, "raw");
  const dirs = todayOnly
    ? [formatIsoDate(ctx.now())]
    : await listDirectoryNames(rawRoot);
  let count = 0;
  for (const dir of dirs) {
    const fullDir = join(rawRoot, dir);
    let entries: string[];
    try {
      entries = await readdir(fullDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      if (!prefixes.some((prefix) => entry.startsWith(prefix))) continue;
      const info = await stat(join(fullDir, entry));
      if (!todayOnly || ctx.now().getTime() - info.mtime.getTime() <= DAY_MS) {
        count += 1;
      }
    }
  }
  return count;
}

async function listDirectoryNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function antigravityConfigPath(): string {
  return join(
    process.env["MEMORY_ANTIGRAVITY_DIR"] ??
      join(homedir(), ".gemini", "antigravity"),
    "mcp_config.json",
  );
}
