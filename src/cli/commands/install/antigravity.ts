import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { memoryRoot, logPath } from "../../../storage/paths.js";
import { atomicWrite, atomicAppend } from "../../../storage/atomic-write.js";

export interface InstallAntigravityOptions {
  /** Override ~/.gemini/antigravity/ (default). */
  antigravityDir?: string;
  /** Antigravity Editor and workspace currently share the same MCP config. */
  surface?: "workspace" | "ide" | "both";
  /** For tests. */
  now?: Date;
}

export interface InstallAntigravityResult {
  mcpConfigPath: string;
  configCreated: boolean;
  hadPriorMemoryEntry: boolean;
  surfaces: Array<"workspace" | "ide">;
  log: string[];
}

function mcpServerAbs(): string {
  return join(memoryRoot(), "claude-code-plugin", "scripts", "mcp-server.mjs").replace(
    /\\/g,
    "/",
  );
}

export async function installAntigravity(
  opts: InstallAntigravityOptions = {},
): Promise<InstallAntigravityResult> {
  const antigravityDir =
    opts.antigravityDir ??
    process.env["MEMORY_ANTIGRAVITY_DIR"] ??
    join(homedir(), ".gemini", "antigravity");
  const configPath = join(antigravityDir, "mcp_config.json");

  const log: string[] = [];

  let existing: Record<string, unknown> = {};
  let configCreated = false;
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf-8");
    if (raw.trim().length > 0) {
      try {
        existing = JSON.parse(raw) as Record<string, unknown>;
        if (typeof existing !== "object" || existing === null) {
          existing = {};
        }
      } catch {
        existing = {};
      }
    } else {
      configCreated = true;
    }
  } else {
    configCreated = true;
  }

  let hadPriorMemoryEntry = false;
  const existingServers = existing["mcpServers"];
  if (
    typeof existingServers === "object" &&
    existingServers !== null &&
    "memory" in (existingServers as Record<string, unknown>)
  ) {
    hadPriorMemoryEntry = true;
  }

  const newServers: Record<string, unknown> =
    typeof existingServers === "object" && existingServers !== null
      ? { ...(existingServers as Record<string, unknown>) }
      : {};

  newServers["memory"] = {
    command: "node",
    args: [mcpServerAbs()],
  };

  const newConfig = { ...existing, mcpServers: newServers };
  await atomicWrite(configPath, JSON.stringify(newConfig, null, 2) + "\n");

  log.push(
    configCreated
      ? `created ${configPath} with memory MCP entry`
      : hadPriorMemoryEntry
        ? `updated memory MCP entry in ${configPath}`
        : `merged memory MCP entry into existing ${configPath}`,
  );

  const now = opts.now ?? new Date();
  const surfaces =
    opts.surface === "workspace"
      ? (["workspace"] as const)
      : opts.surface === "ide"
        ? (["ide"] as const)
        : (["workspace", "ide"] as const);
  await atomicAppend(
    logPath(),
    `## [${now.toISOString()}] install | antigravity ${surfaces.join("+")}: MCP entry in ${configPath}\n`,
  );

  return {
    mcpConfigPath: configPath,
    configCreated,
    hadPriorMemoryEntry,
    surfaces: [...surfaces],
    log,
  };
}
