import { existsSync } from "node:fs";
import { readFile, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite } from "../../storage/atomic-write.js";
import {
  claudeDesktopConfigPath,
  memoryRoot,
} from "../../storage/paths.js";
import { opencodeConfigDir, opencodeConfigPath, opencodePluginPath } from "./install/opencode.js";
import {
  CLAUDE_CODE_ENABLED_PLUGIN_KEY,
  CLAUDE_CODE_MARKETPLACE_NAME,
  claudePluginExecFile,
  claudeCodeSettingsPath,
  runClaudePluginCommand,
  shouldSyncClaudePluginCache,
  type ClaudePluginExecFile,
} from "./install/claude-code.js";
import { stripPriorBlock } from "./install/codex.js";
import { vscodeExtensionDir, vscodeMcpConfigPath } from "./install/vscode.js";

export type UninstallPlatform =
  | "claude-code"
  | "codex"
  | "antigravity"
  | "hermes"
  | "pi"
  | "openclaw"
  | "opencode"
  | "opencoven"
  | "claude-desktop"
  | "vscode";

export interface RunUninstallOptions {
  dryRun?: boolean;
  workspace?: string;
  codexDir?: string;
  claudeDir?: string;
  antigravityDir?: string;
  hermesDir?: string;
  piDir?: string;
  openclawDir?: string;
  opencodeDir?: string;
  vscodeUserDir?: string;
  vscodeExtensionDir?: string;
  claudePluginCli?: boolean;
  execFileFn?: ClaudePluginExecFile;
}

export interface UninstallResult {
  platform: string;
  dryRun: boolean;
  actions: string[];
  removed: boolean;
  exitCode: 0 | 2;
}

type JsonServerMapKey = "mcpServers" | "servers" | "mcp";

export async function runUninstall(
  platform: string,
  opts: RunUninstallOptions = {},
): Promise<UninstallResult> {
  switch (platform) {
    case "claude-code":
      return uninstallClaudeCode(opts);
    case "codex":
      return uninstallCodex(opts);
    case "antigravity":
      return uninstallAntigravity(opts);
    case "hermes":
      return uninstallHermes(opts);
    case "pi":
      return uninstallPi(opts);
    case "openclaw":
      return uninstallOpenClaw(opts);
    case "opencode":
      return uninstallOpenCode(opts);
    case "opencoven":
      return result(
        "opencoven",
        opts,
        ["read-only integration; no Memory Fort files to remove"],
        true,
      );
    case "claude-desktop":
      return uninstallClaudeDesktop(opts);
    case "vscode":
      return uninstallVsCode(opts);
    default:
      return {
        platform,
        dryRun: opts.dryRun === true,
        actions: [
          `Unknown platform: ${platform}. Valid: claude-code, codex, antigravity, hermes, pi, openclaw, opencode, opencoven, claude-desktop, vscode`,
        ],
        removed: false,
        exitCode: 2,
      };
  }
}

export function formatUninstallResult(result: UninstallResult): string {
  const heading = result.dryRun
    ? `Dry run for memory uninstall ${result.platform}`
    : `memory uninstall ${result.platform}`;
  const actions = result.actions.length > 0
    ? result.actions.map((action) => `  - ${action}`).join("\n")
    : "  - nothing to remove";
  return `${heading}\n${actions}\n`;
}

async function uninstallCodex(opts: RunUninstallOptions): Promise<UninstallResult> {
  const configPath = join(
    opts.codexDir ?? process.env["MEMORY_CODEX_DIR"] ?? join(homedir(), ".codex"),
    "config.toml",
  );
  const actions: string[] = [];
  if (!existsSync(configPath)) {
    return result("codex", opts, [`not installed: ${configPath} missing`], false);
  }

  const existing = await readFile(configPath, "utf-8");
  const stripped = stripPriorBlock(existing);
  if (!stripped.replaced) {
    return result("codex", opts, [`not installed: no memory-system block in ${configPath}`], false);
  }

  const restored = normalizeCodexConfigAfterUninstall(
    stripped.content,
    stripped.priorTrailingNewlines,
  );
  if (restored.trim().length === 0) {
    actions.push(`remove ${configPath}`);
    if (!opts.dryRun) await unlink(configPath);
  } else {
    actions.push(`remove memory-system block from ${configPath}`);
    if (!opts.dryRun) await atomicWrite(configPath, restored);
  }
  return result("codex", opts, actions, true);
}

async function uninstallHermes(opts: RunUninstallOptions): Promise<UninstallResult> {
  const configPath = join(
    opts.hermesDir ?? process.env["MEMORY_HERMES_DIR"] ?? join(homedir(), ".hermes"),
    "config.yaml",
  );
  return uninstallSentinelYaml("hermes", configPath, opts);
}

async function uninstallPi(opts: RunUninstallOptions): Promise<UninstallResult> {
  const configPath = join(
    opts.piDir ?? process.env["MEMORY_PI_DIR"] ?? join(homedir(), ".pi"),
    "config.yaml",
  );
  return uninstallSentinelYaml("pi", configPath, opts);
}

async function uninstallOpenClaw(opts: RunUninstallOptions): Promise<UninstallResult> {
  const openclawDir =
    opts.openclawDir ?? process.env["MEMORY_OPENCLAW_DIR"] ?? join(homedir(), ".openclaw");
  return removeJsonMemoryServer({
    platform: "openclaw",
    configPath: join(openclawDir, "openclaw.json"),
    serverMapKey: "mcpServers",
    opts,
  });
}

async function uninstallOpenCode(opts: RunUninstallOptions): Promise<UninstallResult> {
  const openCodeDir = opencodeConfigDir(opts.opencodeDir);
  const configPath = opencodeConfigPath(openCodeDir);
  let configResult: UninstallResult;
  try {
    configResult = await removeJsonMemoryServer({
      platform: "opencode",
      configPath,
      serverMapKey: "mcp",
      opts,
    });
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    configResult = result(
      "opencode",
      opts,
      [
        `skipped memory MCP removal from ${configPath}: failed to parse config; repair opencode.json and rerun uninstall`,
      ],
      false,
    );
  }
  const pluginRemoved = await removePathIfPresent(
    opencodePluginPath(openCodeDir),
    opts,
    configResult.actions,
  );
  return {
    ...configResult,
    removed: configResult.removed || pluginRemoved,
  };
}

async function uninstallSentinelYaml(
  platform: "hermes" | "pi",
  configPath: string,
  opts: RunUninstallOptions,
): Promise<UninstallResult> {
  const actions: string[] = [];
  if (!existsSync(configPath)) {
    return result(platform, opts, [`not installed: ${configPath} missing`], false);
  }

  const existing = await readFile(configPath, "utf-8");
  const stripped = stripPriorBlock(existing);
  if (!stripped.replaced) {
    return result(platform, opts, [`not installed: no memory-system block in ${configPath}`], false);
  }

  const restored = normalizeSentinelConfigAfterUninstall(
    stripped.content,
    stripped.priorTrailingNewlines,
  );
  if (restored.trim().length === 0) {
    actions.push(`remove ${configPath}`);
    if (!opts.dryRun) await unlink(configPath);
  } else {
    actions.push(`remove memory-system block from ${configPath}`);
    if (!opts.dryRun) await atomicWrite(configPath, restored);
  }
  return result(platform, opts, actions, true);
}

async function uninstallClaudeDesktop(opts: RunUninstallOptions): Promise<UninstallResult> {
  const configPath = claudeDesktopConfigPath();
  return removeJsonMemoryServer({
    platform: "claude-desktop",
    configPath,
    serverMapKey: "mcpServers",
    opts,
  });
}

async function uninstallAntigravity(opts: RunUninstallOptions): Promise<UninstallResult> {
  const antigravityDir =
    opts.antigravityDir ??
    process.env["MEMORY_ANTIGRAVITY_DIR"] ??
    join(homedir(), ".gemini", "antigravity");
  const configResult = await removeJsonMemoryServer({
    platform: "antigravity",
    configPath: join(antigravityDir, "mcp_config.json"),
    serverMapKey: "mcpServers",
    opts,
  });
  const pluginDir = join(antigravityDir, "plugins", "memory");
  const pluginRemoved = await removePathIfPresent(pluginDir, opts, configResult.actions);
  return {
    ...configResult,
    removed: configResult.removed || pluginRemoved,
  };
}

async function uninstallVsCode(opts: RunUninstallOptions): Promise<UninstallResult> {
  const configResult = await removeJsonMemoryServer({
    platform: "vscode",
    configPath: vscodeMcpConfigPath({
      userDir: opts.vscodeUserDir,
      workspace: opts.workspace,
    }),
    serverMapKey: "servers",
    opts,
  });
  const extensionRemoved = await removePathIfPresent(
    join(vscodeExtensionDir(opts.vscodeExtensionDir), "memory-fort.memory"),
    opts,
    configResult.actions,
  );
  return {
    ...configResult,
    removed: configResult.removed || extensionRemoved,
  };
}

async function uninstallClaudeCode(opts: RunUninstallOptions): Promise<UninstallResult> {
  const actions: string[] = [];
  let removed = false;
  const cacheRemoved = await uninstallClaudeCodePluginCache(opts, actions);
  const settingsRemoved = await removeClaudeCodeSettings(opts, actions);
  const pluginRemoved = await removePathIfPresent(
    join(memoryRoot(), "claude-code-plugin"),
    opts,
    actions,
  );
  const marketplacePath = join(memoryRoot(), ".claude-plugin", "marketplace.json");
  const marketplaceRemoved = await removePathIfPresent(marketplacePath, opts, actions);
  if (!opts.dryRun && marketplaceRemoved) {
    await removeDirIfEmpty(dirname(marketplacePath));
  }

  removed = cacheRemoved || settingsRemoved || pluginRemoved || marketplaceRemoved;
  if (!removed) actions.push("not installed: Claude Code memory plugin settings/files missing");
  return result("claude-code", opts, actions, removed);
}

async function uninstallClaudeCodePluginCache(
  opts: RunUninstallOptions,
  actions: string[],
): Promise<boolean> {
  if (!shouldSyncClaudePluginCache(opts)) {
    actions.push("skipped Claude plugin cache uninstall for custom Claude config dir");
    return false;
  }
  if (opts.dryRun) {
    actions.push(`would uninstall ${CLAUDE_CODE_ENABLED_PLUGIN_KEY} from Claude Code plugin cache`);
    actions.push(`would remove ${CLAUDE_CODE_MARKETPLACE_NAME} Claude Code marketplace`);
    return false;
  }

  const log: string[] = [];
  const execFileFn = opts.execFileFn ?? claudePluginExecFile;
  await runClaudePluginCommand(
    execFileFn,
    ["plugin", "uninstall", CLAUDE_CODE_ENABLED_PLUGIN_KEY],
    `uninstalled ${CLAUDE_CODE_ENABLED_PLUGIN_KEY} from Claude Code plugin cache`,
    log,
    {
      allowNotInstalled: true,
      missingCliLog: "skipped Claude plugin cache uninstall: claude CLI not found on PATH",
    },
  );
  await runClaudePluginCommand(
    execFileFn,
    ["plugin", "marketplace", "remove", CLAUDE_CODE_MARKETPLACE_NAME],
    `removed ${CLAUDE_CODE_MARKETPLACE_NAME} Claude Code marketplace`,
    log,
    {
      allowNotInstalled: true,
      missingCliLog: "skipped Claude plugin cache uninstall: claude CLI not found on PATH",
    },
  );
  actions.push(...log);
  return log.some((entry) => !entry.includes("not installed") && !entry.includes("not found on PATH"));
}

async function removeClaudeCodeSettings(
  opts: RunUninstallOptions,
  actions: string[],
): Promise<boolean> {
  const settingsPath = claudeCodeSettingsPath(opts.claudeDir);
  if (!existsSync(settingsPath)) return false;
  const settings = await readJsonObject(settingsPath);
  let changed = false;
  const enabledPlugins = asRecord(settings["enabledPlugins"]);
  if (enabledPlugins && CLAUDE_CODE_ENABLED_PLUGIN_KEY in enabledPlugins) {
    delete enabledPlugins[CLAUDE_CODE_ENABLED_PLUGIN_KEY];
    if (Object.keys(enabledPlugins).length === 0) delete settings["enabledPlugins"];
    changed = true;
  }
  const marketplaces = asRecord(settings["extraKnownMarketplaces"]);
  if (marketplaces && CLAUDE_CODE_MARKETPLACE_NAME in marketplaces) {
    delete marketplaces[CLAUDE_CODE_MARKETPLACE_NAME];
    if (Object.keys(marketplaces).length === 0) delete settings["extraKnownMarketplaces"];
    changed = true;
  }
  if (!changed) return false;

  if (Object.keys(settings).length === 0) {
    actions.push(`remove empty Claude Code settings ${settingsPath}`);
    if (!opts.dryRun) await unlink(settingsPath);
  } else {
    actions.push(`remove Claude Code memory plugin keys from ${settingsPath}`);
    if (!opts.dryRun) await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return true;
}

async function removeJsonMemoryServer(args: {
  platform: UninstallPlatform;
  configPath: string;
  serverMapKey: JsonServerMapKey;
  opts: RunUninstallOptions;
}): Promise<UninstallResult> {
  const { platform, configPath, serverMapKey, opts } = args;
  if (!existsSync(configPath)) {
    return result(platform, opts, [`not installed: ${configPath} missing`], false);
  }

  const config = await readJsonObject(configPath);
  const servers = asRecord(config[serverMapKey]);
  if (!servers || !("memory" in servers)) {
    return result(platform, opts, [`not installed: memory entry missing from ${configPath}`], false);
  }

  delete servers["memory"];
  if (Object.keys(servers).length === 0) {
    delete config[serverMapKey];
  } else {
    config[serverMapKey] = servers;
  }

  const actions = [`remove memory server from ${configPath}`];
  if (Object.keys(config).length === 0) {
    actions[0] = `remove ${configPath}`;
    if (!opts.dryRun) await unlink(configPath);
  } else if (!opts.dryRun) {
    await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  return result(platform, opts, actions, true);
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf-8");
  const parsed = raw.trim().length === 0 ? {} : JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

async function removePathIfPresent(
  path: string,
  opts: RunUninstallOptions,
  actions: string[],
): Promise<boolean> {
  if (!existsSync(path)) return false;
  actions.push(`remove ${path}`);
  if (!opts.dryRun) await rm(path, { recursive: true, force: true });
  return true;
}

async function removeDirIfEmpty(path: string): Promise<void> {
  try {
    const entries = await readdir(path);
    if (entries.length === 0) await rmdir(path);
  } catch {
    // Directory may not exist or may contain user files; both are safe no-ops.
  }
}

function normalizeCodexConfigAfterUninstall(
  content: string,
  priorTrailingNewlines?: number,
): string {
  return normalizeSentinelConfigAfterUninstall(content, priorTrailingNewlines);
}

function normalizeSentinelConfigAfterUninstall(
  content: string,
  priorTrailingNewlines?: number,
): string {
  if (priorTrailingNewlines !== undefined) {
    return `${content.replace(/\n+$/u, "")}${"\n".repeat(priorTrailingNewlines)}`;
  }
  return content.replace(/\n{2,}$/u, "\n");
}

function result(
  platform: UninstallPlatform,
  opts: RunUninstallOptions,
  actions: string[],
  removed: boolean,
): UninstallResult {
  return {
    platform,
    dryRun: opts.dryRun === true,
    actions,
    removed,
    exitCode: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
