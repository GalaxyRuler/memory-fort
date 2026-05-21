import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { lstat, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import {
  memoryRoot,
  logPath,
  scriptsDir,
} from "../../../storage/paths.js";
import { atomicWrite, atomicAppend } from "../../../storage/atomic-write.js";
import { ensureSymlinkOrJunction } from "../../util/symlink-or-junction.js";

export interface InstallClaudeCodeOptions {
  /** Override repo path (default: derived from this script's location). */
  repoDir?: string;
  /** Override Claude Code config dir (default: ~/.claude). */
  claudeDir?: string;
  /** For tests: override the date. */
  now?: Date;
}

export interface InstallClaudeCodeResult {
  pluginDir: string;
  scriptsLink: string;
  pluginMcpConfigPath: string;
  legacyMigrated: boolean;
  log: string[];
}

const HOOKS_JSON = {
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs",
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/prompt-submit.mjs",
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          {
            type: "command",
            command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/post-tool-use.mjs",
          },
        ],
      },
    ],
    PreCompact: [
      {
        hooks: [
          {
            type: "command",
            command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.mjs",
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/session-end.mjs",
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
  const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
  const hooksPath = join(pluginDir, "hooks", "hooks.json");
  const pluginMcpConfigPath = join(pluginDir, ".mcp.json");
  const pluginScriptsDir = join(pluginDir, "scripts");
  const repoHooks = join(repoDir, "dist", "hooks");

  await atomicWrite(manifestPath, JSON.stringify(PLUGIN_MANIFEST, null, 2) + "\n");
  log.push(`wrote plugin manifest at ${manifestPath}`);

  await atomicWrite(hooksPath, JSON.stringify(HOOKS_JSON, null, 2) + "\n");
  log.push(`wrote hooks.json at ${hooksPath}`);

  if (!existsSync(repoHooks)) {
    throw new Error(`repo hooks dir not built: ${repoHooks} — run 'npm run build' first`);
  }
  await removeOldTopLevelScriptsLink();
  const linkResult = await ensureSymlinkOrJunction(repoHooks, pluginScriptsDir, {
    force: true,
  });
  log.push(`${linkResult} plugin scripts link ${pluginScriptsDir} -> ${repoHooks}`);

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

  const now = opts.now ?? new Date();
  await atomicAppend(
    logPath(),
    `## [${now.toISOString()}] install | claude-code: plugin + hooks + MCP\n`,
  );

  return {
    pluginDir,
    scriptsLink: pluginScriptsDir,
    pluginMcpConfigPath,
    legacyMigrated,
    log,
  };
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
