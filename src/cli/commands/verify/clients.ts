import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeDesktopConfigDir,
  claudeDesktopConfigPath,
  formatIsoDate,
} from "../../../storage/paths.js";
import {
  isClaudeCodePluginEnabled,
} from "../install/claude-code.js";
import { vscodeExtensionDir, vscodeMcpConfigPath } from "../install/vscode.js";
import { fail, pass, warn, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const claudeCodeEnabledCheck: CheckDescriptor = {
  id: "client.claude-code.enabled",
  label: "Claude Code plugin enabled",
  roles: ["operator"],
  run: () => checkClaudeCodeEnabled(),
};

export const claudeCodeCaptureCheck: CheckDescriptor = {
  id: "client.claude-code.capture",
  label: "Claude Code capture is fresh",
  roles: ["operator"],
  run: (ctx) => checkRecentCapture(ctx, ["claude-code-", "claude-"], "client.claude-code.capture", "claude-code"),
};

export const snifferClaudeCodeBackfillCheck: CheckDescriptor = {
  id: "sniffer.claude-code.backfill",
  label: "Claude Code backfill store available",
  roles: ["operator"],
  run: () => checkClaudeCodeBackfillStore(),
};

export const codexConfigCheck: CheckDescriptor = {
  id: "client.codex.config",
  label: "Codex MCP block present",
  roles: ["operator"],
  run: () => checkCodexConfig(),
};

export const codexCaptureCheck: CheckDescriptor = {
  id: "client.codex.capture",
  label: "Codex capture is fresh",
  roles: ["operator"],
  run: (ctx) => checkRecentCapture(ctx, ["codex-"], "client.codex.capture", "codex"),
};

export const antigravityConfigCheck: CheckDescriptor = {
  id: "client.antigravity.config",
  label: "Antigravity MCP entry present",
  roles: ["operator"],
  run: () => checkJsonServer(
    antigravityConfigPath(),
    "mcpServers",
    "client.antigravity.config",
    "antigravity MCP entry present (informational)",
    "run `memory connect antigravity`",
    true,
  ),
};

export const snifferAntigravityPluginCheck: CheckDescriptor = {
  id: "sniffer.antigravity.plugin",
  label: "Antigravity live-capture plugin installed",
  roles: ["operator"],
  run: () => checkAntigravityPlugin(),
};

export const antigravityCaptureCheck: CheckDescriptor = {
  id: "client.antigravity.capture",
  label: "Antigravity captures present",
  roles: ["operator"],
  run: (ctx) => checkAnyCapture(ctx, ["antigravity-"], "client.antigravity.capture"),
};

export const vscodeConfigCheck: CheckDescriptor = {
  id: "client.vscode.config",
  label: "VS Code MCP entry present",
  roles: ["operator"],
  run: () => checkJsonServer(
    vscodeMcpConfigPath(),
    "servers",
    "client.vscode.config",
    "vscode MCP entry present",
    "run `memory connect vscode`",
  ),
};

export const snifferVscodeExtensionCheck: CheckDescriptor = {
  id: "sniffer.vscode.extension",
  label: "VS Code Memory Fort extension installed",
  roles: ["operator"],
  run: () => checkVsCodeExtension(),
};

export const snifferVscodeCaptureCheck: CheckDescriptor = {
  id: "sniffer.vscode.capture",
  label: "VS Code extension capture is fresh",
  roles: ["operator"],
  run: (ctx) => checkRecentCapture(ctx, ["vscode-"], "sniffer.vscode.capture", "vscode extension"),
};

export const claudeDesktopConfigCheck: CheckDescriptor = {
  id: "client.claude-desktop.config",
  label: "Claude Desktop MCP entry present",
  roles: ["operator"],
  run: () => checkJsonServer(
    claudeDesktopConfigPath(),
    "mcpServers",
    "client.claude-desktop.config",
    "claude-desktop MCP entry present",
    "run `memory connect claude-desktop`",
  ),
};

export const snifferClaudeDesktopWatcherCheck: CheckDescriptor = {
  id: "sniffer.claude-desktop.watcher",
  label: "Claude Desktop watcher source available",
  roles: ["operator"],
  run: () => checkClaudeDesktopWatcher(),
};

export const snifferClaudeDesktopCaptureCheck: CheckDescriptor = {
  id: "sniffer.claude-desktop.capture",
  label: "Claude Desktop watcher capture is fresh",
  roles: ["operator"],
  run: (ctx) => checkRecentCapture(ctx, ["claude-desktop-"], "sniffer.claude-desktop.capture", "claude-desktop watcher"),
};

export const CLIENT_CHECKS: CheckDescriptor[] = [
  claudeCodeEnabledCheck,
  claudeCodeCaptureCheck,
  snifferClaudeCodeBackfillCheck,
  codexConfigCheck,
  codexCaptureCheck,
  antigravityConfigCheck,
  snifferAntigravityPluginCheck,
  antigravityCaptureCheck,
  vscodeConfigCheck,
  snifferVscodeExtensionCheck,
  snifferVscodeCaptureCheck,
  claudeDesktopConfigCheck,
  snifferClaudeDesktopWatcherCheck,
  snifferClaudeDesktopCaptureCheck,
];

export async function checkClients(
  ctx: VerifyCheckContext,
): Promise<VerifyCheckResult[]> {
  return (await Promise.all(CLIENT_CHECKS.map((check) => check.run(ctx)))).flat();
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
    ? pass(id, "antigravity live hooks captured", `${count} captures`)
    : warn(
        id,
        "antigravity live hooks have not captured yet",
        "no antigravity captures found",
      );
}

async function checkClaudeCodeBackfillStore(): Promise<VerifyCheckResult> {
  const projectsDir =
    process.env["MEMORY_CLAUDE_PROJECTS_DIR"] ?? join(homedir(), ".claude", "projects");
  return existsSync(projectsDir)
    ? pass("sniffer.claude-code.backfill", "claude-code backfill store available")
    : warn(
        "sniffer.claude-code.backfill",
        "claude-code backfill store available",
        `missing at ${projectsDir}`,
      );
}

async function checkAntigravityPlugin(): Promise<VerifyCheckResult> {
  const pluginDir = join(antigravityDir(), "plugins", "memory");
  const manifestPath = join(pluginDir, "plugin.json");
  const hooksPath = join(pluginDir, "hooks.json");
  if (!existsSync(manifestPath) || !existsSync(hooksPath)) {
    return warn(
      "sniffer.antigravity.plugin",
      "antigravity live-capture plugin installed",
      `missing plugin files at ${pluginDir}`,
      "run `memory connect antigravity`",
    );
  }

  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
    const hooks = JSON.parse(await readFile(hooksPath, "utf-8")) as Record<string, unknown>;
    const hookMap = hooks["hooks"];
    const hasManifest = manifest["name"] === "memory" && manifest["hooks"] === "./hooks.json";
    const hasHooks = typeof hookMap === "object" && hookMap !== null;
    const missingHook = ANTIGRAVITY_HOOK_NAMES.find(
      (hook) => !(hasHooks && hook in (hookMap as Record<string, unknown>)) ||
        !existsSync(join(pluginDir, "hooks", `${hook}.mjs`)),
    );
    return hasManifest && !missingHook
      ? pass("sniffer.antigravity.plugin", "antigravity live-capture plugin installed")
      : warn(
          "sniffer.antigravity.plugin",
          "antigravity live-capture plugin installed",
          missingHook ? `missing hook ${missingHook}` : "plugin manifest invalid",
          "run `memory connect antigravity`",
        );
  } catch {
    return warn(
      "sniffer.antigravity.plugin",
      "antigravity live-capture plugin installed",
      "plugin JSON is malformed",
      "run `memory connect antigravity`",
    );
  }
}

async function checkClaudeDesktopWatcher(): Promise<VerifyCheckResult> {
  const dir = claudeDesktopConfigDir();
  return existsSync(dir)
    ? pass("sniffer.claude-desktop.watcher", "claude-desktop watcher source available")
    : warn(
        "sniffer.claude-desktop.watcher",
        "claude-desktop watcher source available",
        `missing at ${dir}`,
        "run Claude Desktop once, then `memory watch --clients claude-desktop`",
      );
}

async function checkVsCodeExtension(): Promise<VerifyCheckResult> {
  const extensionPath = join(vscodeExtensionDir(), "memory-fort.memory", "package.json");
  if (!existsSync(extensionPath)) {
    return warn(
      "sniffer.vscode.extension",
      "vscode Memory Fort extension installed",
      `missing at ${extensionPath}`,
      "run `memory connect vscode`",
    );
  }
  try {
    const parsed = JSON.parse(await readFile(extensionPath, "utf-8")) as Record<string, unknown>;
    const contributes = parsed["contributes"] as Record<string, unknown> | undefined;
    const participants = contributes?.["chatParticipants"];
    const ok = Array.isArray(participants) &&
      participants.some((entry) => {
        const participant = entry as Record<string, unknown>;
        return participant["id"] === "memory-fort.memory";
      });
    return ok
      ? pass("sniffer.vscode.extension", "vscode Memory Fort extension installed")
      : warn(
          "sniffer.vscode.extension",
          "vscode Memory Fort extension installed",
          "chat participant missing",
          "run `memory connect vscode`",
        );
  } catch {
    return warn(
      "sniffer.vscode.extension",
      "vscode Memory Fort extension installed",
      "extension package JSON is malformed",
      "run `memory connect vscode`",
    );
  }
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
  return join(antigravityDir(), "mcp_config.json");
}

function antigravityDir(): string {
  return process.env["MEMORY_ANTIGRAVITY_DIR"] ??
    join(homedir(), ".gemini", "antigravity");
}

const ANTIGRAVITY_HOOK_NAMES = [
  "session_start",
  "pre_turn",
  "post_turn",
  "pre_tool_call",
  "post_tool_call",
  "tool_error_recovery",
  "user_interaction_handling",
  "context_compaction",
  "session_end",
] as const;
