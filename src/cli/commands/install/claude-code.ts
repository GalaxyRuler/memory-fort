import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  memoryRoot,
  logPath,
  scriptsDir,
} from "../../../storage/paths.js";
import { atomicWrite, atomicAppend } from "../../../storage/atomic-write.js";

export const claudePluginExecFile = promisify(execFileCallback);
export type ClaudePluginExecFile = typeof claudePluginExecFile;

export interface InstallClaudeCodeOptions {
  /** Override repo path (default: derived from this script's location). */
  repoDir?: string;
  /** Override Claude Code config dir (default: ~/.claude). */
  claudeDir?: string;
  /** For tests: override the date. */
  now?: Date;
  /** For tests/portable installs: override or disable the Claude plugin CLI sync. */
  claudePluginCli?: boolean;
  /** For tests: inject command execution. */
  execFileFn?: ClaudePluginExecFile;
}

export interface InstallClaudeCodeResult {
  pluginDir: string;
  scriptsLink: string;
  pluginMcpConfigPath: string;
  settingsPath: string;
  enabledPluginKey: string;
  legacyMigrated: boolean;
  log: string[];
}

export const CLAUDE_CODE_MARKETPLACE_NAME = "memory-local";
export const CLAUDE_CODE_PLUGIN_NAME = "memory";
export const CLAUDE_CODE_ENABLED_PLUGIN_KEY = `${CLAUDE_CODE_PLUGIN_NAME}@${CLAUDE_CODE_MARKETPLACE_NAME}`;

const HOOKS_JSON = {
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"],
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/scripts/prompt-submit.mjs"],
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          {
            type: "command",
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/scripts/post-tool-use.mjs"],
          },
        ],
      },
    ],
    PreCompact: [
      {
        hooks: [
          {
            type: "command",
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.mjs"],
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/scripts/session-end.mjs"],
          },
        ],
      },
    ],
  },
};

const PLUGIN_MANIFEST = {
  name: "memory",
  version: "0.1.0",
  description: "Cross-tool memory system hooks for Claude Code",
  author: {
    name: "GalaxyRuler",
    url: "https://github.com/GalaxyRuler",
  },
  hooks: "./hooks/hooks.json",
  mcpServers: "./.mcp.json",
};

const MARKETPLACE_MANIFEST = {
  name: CLAUDE_CODE_MARKETPLACE_NAME,
  owner: {
    name: "GalaxyRuler",
  },
  plugins: [
    {
      name: CLAUDE_CODE_PLUGIN_NAME,
      source: "./claude-code-plugin",
    },
  ],
};

export async function installClaudeCode(
  opts: InstallClaudeCodeOptions = {},
): Promise<InstallClaudeCodeResult> {
  const claudeDir =
    opts.claudeDir ?? process.env["MEMORY_CLAUDE_DIR"] ?? join(homedir(), ".claude");
  const repoDir = opts.repoDir ?? process.env["MEMORY_REPO_DIR"] ?? resolveRepoDir();
  const root = memoryRoot();
  const log: string[] = [];

  const pluginDir = join(root, "claude-code-plugin");
  const marketplacePath = join(root, ".claude-plugin", "marketplace.json");
  const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
  const hooksPath = join(pluginDir, "hooks", "hooks.json");
  const pluginMcpConfigPath = join(pluginDir, ".mcp.json");
  const pluginScriptsDir = join(pluginDir, "scripts");
  const repoHooks = join(repoDir, "dist", "hooks");

  await atomicWrite(manifestPath, JSON.stringify(PLUGIN_MANIFEST, null, 2) + "\n");
  log.push(`wrote plugin manifest at ${manifestPath}`);

  await atomicWrite(
    marketplacePath,
    JSON.stringify(MARKETPLACE_MANIFEST, null, 2) + "\n",
  );
  log.push(`wrote local marketplace catalog at ${marketplacePath}`);

  await atomicWrite(hooksPath, JSON.stringify(HOOKS_JSON, null, 2) + "\n");
  log.push(`wrote hooks.json at ${hooksPath}`);

  if (!existsSync(repoHooks)) {
    throw new Error(`repo hooks dir not built: ${repoHooks} — run 'npm run build' first`);
  }
  await removeOldTopLevelScriptsLink();
  await replacePluginScriptsDir(repoHooks, pluginScriptsDir);
  log.push(`wrote plugin script launchers ${pluginScriptsDir} -> ${repoHooks}`);

  const legacyMigrated = await migrateLegacyUserMcp(claudeDir, log);
  const pluginMcpConfig = {
    mcpServers: {
      memory: {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"],
      },
    },
  };
  await atomicWrite(pluginMcpConfigPath, JSON.stringify(pluginMcpConfig, null, 2) + "\n");
  log.push(`wrote plugin MCP config at ${pluginMcpConfigPath}`);

  const settingsPath = await enableClaudeCodePlugin(claudeDir, root, log);
  await syncClaudeCodePluginCache(root, opts, log);

  const now = opts.now ?? new Date();
  await atomicAppend(
    logPath(),
    `## [${now.toISOString()}] install | claude-code: plugin + hooks + MCP + enabled\n`,
  );

  return {
    pluginDir,
    scriptsLink: pluginScriptsDir,
    pluginMcpConfigPath,
    settingsPath,
    enabledPluginKey: CLAUDE_CODE_ENABLED_PLUGIN_KEY,
    legacyMigrated,
    log,
  };
}

export function claudeCodeSettingsPath(claudeDir?: string): string {
  return join(
    claudeDir ?? process.env["MEMORY_CLAUDE_DIR"] ?? join(homedir(), ".claude"),
    "settings.json",
  );
}

export async function isClaudeCodePluginEnabled(
  claudeDir?: string,
): Promise<boolean> {
  const settingsPath = claudeCodeSettingsPath(claudeDir);
  if (!existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const enabledPlugins = settings["enabledPlugins"];
    if (typeof enabledPlugins !== "object" || enabledPlugins === null) return false;
    return (
      (enabledPlugins as Record<string, unknown>)[CLAUDE_CODE_ENABLED_PLUGIN_KEY] ===
      true
    );
  } catch {
    return false;
  }
}

function resolveRepoDir(): string {
  let dir = dirname(new URL(import.meta.url).pathname).replace(/^\/(\w):/, "$1:");
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate repo root from script location");
}

async function removeOldTopLevelScriptsLink(): Promise<void> {
  const oldScripts = scriptsDir();
  try {
    const st = await lstat(oldScripts);
    if (st.isSymbolicLink()) await unlink(oldScripts);
  } catch {
    // Missing path or unlink failure is not fatal; the plugin-local
    // scripts link is authoritative after this fix.
  }
}

async function replacePluginScriptsDir(sourceDir: string, targetDir: string): Promise<void> {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    const targetHref = pathToFileURL(join(sourceDir, entry.name)).href;
    await writeFile(
      join(targetDir, entry.name),
      [
        "// Generated by memory install claude-code.",
        `export const memoryHookTarget = ${JSON.stringify(targetHref)};`,
        "await import(memoryHookTarget);",
        "",
      ].join("\n"),
      "utf-8",
    );
  }
}

async function migrateLegacyUserMcp(
  claudeDir: string,
  log: string[],
): Promise<boolean> {
  const legacy = join(claudeDir, ".mcp.json");
  if (!existsSync(legacy)) return false;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(legacy, "utf-8")) as Record<string, unknown>;
  } catch {
    return false;
  }

  const servers = parsed["mcpServers"];
  if (typeof servers !== "object" || servers === null) return false;
  const serverMap = servers as Record<string, unknown>;
  if (!("memory" in serverMap)) return false;

  delete serverMap["memory"];

  const remainingServerKeys = Object.keys(serverMap);
  const remainingTopKeys = Object.keys(parsed).filter((key) => key !== "mcpServers");
  if (remainingServerKeys.length === 0 && remainingTopKeys.length === 0) {
    await unlink(legacy);
    log.push(`removed legacy ${legacy} (only contained our memory entry)`);
  } else {
    if (remainingServerKeys.length === 0) {
      delete parsed["mcpServers"];
    }
    await atomicWrite(legacy, JSON.stringify(parsed, null, 2) + "\n");
    log.push(`removed memory entry from ${legacy}; preserved other entries`);
  }

  return true;
}

async function enableClaudeCodePlugin(
  claudeDir: string,
  marketplaceRoot: string,
  log: string[],
): Promise<string> {
  const settingsPath = claudeCodeSettingsPath(claudeDir);
  const settings = await readClaudeSettings(settingsPath);
  const enabledPlugins = ensureRecord(settings, "enabledPlugins");
  const marketplaces = ensureRecord(settings, "extraKnownMarketplaces");
  const desiredMarketplace = {
    source: {
      source: "directory",
      path: marketplaceRoot,
    },
  };

  let changed = false;
  if (enabledPlugins[CLAUDE_CODE_ENABLED_PLUGIN_KEY] !== true) {
    enabledPlugins[CLAUDE_CODE_ENABLED_PLUGIN_KEY] = true;
    changed = true;
  }

  if (!jsonEqual(marketplaces[CLAUDE_CODE_MARKETPLACE_NAME], desiredMarketplace)) {
    marketplaces[CLAUDE_CODE_MARKETPLACE_NAME] = desiredMarketplace;
    changed = true;
  }

  if (changed) {
    await atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    log.push(
      `enabled ${CLAUDE_CODE_ENABLED_PLUGIN_KEY} in Claude Code settings at ${settingsPath}`,
    );
  } else {
    log.push(
      `${CLAUDE_CODE_ENABLED_PLUGIN_KEY} already enabled in Claude Code settings`,
    );
  }

  return settingsPath;
}

async function syncClaudeCodePluginCache(
  marketplaceRoot: string,
  opts: InstallClaudeCodeOptions,
  log: string[],
): Promise<void> {
  if (!shouldSyncClaudePluginCache(opts)) {
    log.push("skipped Claude plugin cache install for custom Claude config dir");
    return;
  }

  const execFileFn = opts.execFileFn ?? claudePluginExecFile;
  await runClaudePluginCommand(
    execFileFn,
    ["plugin", "marketplace", "add", marketplaceRoot],
    "registered Claude Code marketplace",
    log,
  );
  await runClaudePluginCommand(
    execFileFn,
    ["plugin", "uninstall", CLAUDE_CODE_ENABLED_PLUGIN_KEY],
    `removed stale ${CLAUDE_CODE_ENABLED_PLUGIN_KEY} from Claude Code plugin cache`,
    log,
    { allowNotInstalled: true },
  );
  await runClaudePluginCommand(
    execFileFn,
    ["plugin", "install", CLAUDE_CODE_ENABLED_PLUGIN_KEY],
    `installed ${CLAUDE_CODE_ENABLED_PLUGIN_KEY} in Claude Code plugin cache`,
    log,
  );
}

export function shouldSyncClaudePluginCache(
  opts: Pick<InstallClaudeCodeOptions, "claudePluginCli" | "claudeDir">,
): boolean {
  if (opts.claudePluginCli === false) return false;
  if (opts.claudePluginCli === true) return true;

  const defaultClaudeDir = join(homedir(), ".claude");
  if (opts.claudeDir && opts.claudeDir !== defaultClaudeDir) return false;
  if (process.env["MEMORY_CLAUDE_DIR"] && process.env["MEMORY_CLAUDE_DIR"] !== defaultClaudeDir) {
    return false;
  }
  return true;
}

export async function runClaudePluginCommand(
  execFileFn: ClaudePluginExecFile,
  args: string[],
  successLog: string,
  log: string[],
  opts: { allowNotInstalled?: boolean; missingCliLog?: string } = {},
): Promise<void> {
  try {
    const result = await execFileFn("claude", args, { windowsHide: true });
    const output = result.stdout.trim() || result.stderr.trim();
    log.push(output ? `${successLog}: ${output}` : successLog);
  } catch (err) {
    const error = err as Error & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim();
    if (error.code === "ENOENT") {
      log.push(opts.missingCliLog ?? "skipped Claude plugin cache install: claude CLI not found on PATH");
      return;
    }
    if (opts.allowNotInstalled && /not installed|not found|no installed plugin/i.test(output)) {
      log.push(`${successLog}: not installed`);
      return;
    }
    throw new Error(
      `claude ${args.join(" ")} failed: ${output || error.message}`,
    );
  }
}

async function readClaudeSettings(
  settingsPath: string,
): Promise<Record<string, unknown>> {
  if (!existsSync(settingsPath)) return {};
  const parsed = JSON.parse(await readFile(settingsPath, "utf-8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function ensureRecord(
  target: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = target[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
