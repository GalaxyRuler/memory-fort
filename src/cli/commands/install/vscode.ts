import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mcpServerPath, logPath } from "../../../storage/paths.js";
import { atomicWrite, atomicAppend } from "../../../storage/atomic-write.js";

export interface InstallVsCodeOptions {
  /** Override VS Code user profile dir (default: %APPDATA%/Code/User on Windows). */
  userDir?: string;
  /** Workspace root for .vscode/mcp.json; absent means user-profile mcp.json. */
  workspace?: string;
  /** Test hook / explicit detection override. */
  installed?: boolean;
  now?: Date;
}

export interface InstallVsCodeResult {
  status: "installed" | "skipped";
  configPath?: string;
  scope?: "global" | "workspace";
  configCreated: boolean;
  memoryEntryAction: "created" | "updated" | "unchanged" | "skipped";
  preservedServerCount: number;
  reason?: string;
  log: string[];
}

export function vscodeUserDir(override?: string): string {
  if (override) return override;
  const envOverride = process.env["MEMORY_VSCODE_USER_DIR"];
  if (envOverride && envOverride.trim().length > 0) return envOverride;
  const appData = process.env["APPDATA"];
  if (appData) return join(appData, "Code", "User");
  return join(homedir(), ".config", "Code", "User");
}

export function vscodeMcpConfigPath(opts: {
  userDir?: string;
  workspace?: string;
} = {}): string {
  return opts.workspace
    ? join(opts.workspace, ".vscode", "mcp.json")
    : join(vscodeUserDir(opts.userDir), "mcp.json");
}

export async function installVsCode(
  opts: InstallVsCodeOptions = {},
): Promise<InstallVsCodeResult> {
  const scope = opts.workspace ? "workspace" : "global";
  const userProfileDir = vscodeUserDir(opts.userDir);
  const installed =
    opts.installed ?? (opts.workspace !== undefined || existsSync(userProfileDir));
  const log: string[] = [];

  if (!installed) {
    const reason = `VS Code not found; expected user profile at ${userProfileDir}`;
    return {
      status: "skipped",
      configCreated: false,
      memoryEntryAction: "skipped",
      preservedServerCount: 0,
      reason,
      log: [reason],
    };
  }

  const configPath = vscodeMcpConfigPath({
    userDir: userProfileDir,
    workspace: opts.workspace,
  });
  let existing: Record<string, unknown> = {};
  let configCreated = false;

  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf-8");
    if (raw.trim().length > 0) {
      try {
        existing = JSON.parse(raw) as Record<string, unknown>;
        if (typeof existing !== "object" || existing === null) existing = {};
      } catch (err) {
        throw new Error(
          `memory install vscode: failed to parse existing config at ${configPath}: ${(err as Error).message}`,
        );
      }
    } else {
      configCreated = true;
    }
  } else {
    configCreated = true;
  }

  const existingServers = existing["servers"];
  const servers: Record<string, unknown> =
    typeof existingServers === "object" && existingServers !== null
      ? { ...(existingServers as Record<string, unknown>) }
      : {};

  const memoryEntry = {
    type: "stdio",
    command: "node",
    args: [mcpServerPath().replace(/\\/g, "/")],
  };

  const previous = servers["memory"];
  let memoryEntryAction: "created" | "updated" | "unchanged";
  if (previous === undefined) {
    memoryEntryAction = "created";
  } else if (JSON.stringify(previous) === JSON.stringify(memoryEntry)) {
    memoryEntryAction = "unchanged";
  } else {
    memoryEntryAction = "updated";
  }

  servers["memory"] = memoryEntry;
  const finalConfig = { ...existing, servers };
  await atomicWrite(configPath, JSON.stringify(finalConfig, null, 2) + "\n");

  const preservedServerCount = Object.keys(servers).length - 1;
  log.push(
    configCreated
      ? `created ${configPath} with memory MCP server`
      : `${memoryEntryAction} memory MCP server in ${configPath}`,
  );

  const now = opts.now ?? new Date();
  await atomicAppend(
    logPath(),
    `## [${now.toISOString()}] install | vscode: MCP server in ${configPath}\n`,
  );

  return {
    status: "installed",
    configPath,
    scope,
    configCreated,
    memoryEntryAction,
    preservedServerCount,
    log,
  };
}
