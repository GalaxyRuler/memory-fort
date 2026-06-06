import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite } from "../../../storage/atomic-write.js";
import { memoryRoot } from "../../../storage/paths.js";

export interface InstallOpenClawOptions {
  openclawDir?: string;
}

export interface InstallOpenClawResult {
  configPath: string;
  configCreated: boolean;
  memoryEntryAction: "created" | "updated" | "unchanged";
  preservedServerCount: number;
  log: string[];
}

export async function runInstallOpenClaw(
  opts: InstallOpenClawOptions = {},
): Promise<InstallOpenClawResult> {
  const openclawDir =
    opts.openclawDir ??
    process.env["MEMORY_OPENCLAW_DIR"] ??
    join(homedir(), ".openclaw");
  const configPath = join(openclawDir, "openclaw.json");
  let existingConfig: Record<string, unknown> = {};
  let configCreated = false;
  const log: string[] = [];

  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf-8");
    try {
      existingConfig = raw.trim().length === 0
        ? {}
        : JSON.parse(raw) as Record<string, unknown>;
      if (typeof existingConfig !== "object" || existingConfig === null || Array.isArray(existingConfig)) {
        existingConfig = {};
      }
    } catch (err) {
      throw new Error(
        `memory install openclaw: failed to parse existing config at ${configPath}: ${(err as Error).message}`,
      );
    }
  } else {
    configCreated = true;
    await mkdir(dirname(configPath), { recursive: true });
  }

  const existingServers = existingConfig["mcpServers"];
  const mcpServers: Record<string, unknown> =
    typeof existingServers === "object" && existingServers !== null && !Array.isArray(existingServers)
      ? { ...(existingServers as Record<string, unknown>) }
      : {};

  const newMemoryEntry = {
    command: "node",
    args: [`${memoryRoot().replace(/\\/g, "/")}/hooks/mcp-server.mjs`],
  };

  const existingMemory = mcpServers["memory"];
  let memoryEntryAction: "created" | "updated" | "unchanged";
  if (existingMemory === undefined) {
    memoryEntryAction = "created";
  } else if (JSON.stringify(existingMemory) === JSON.stringify(newMemoryEntry)) {
    memoryEntryAction = "unchanged";
  } else {
    memoryEntryAction = "updated";
    if (!isValidMcpEntry(existingMemory)) {
      log.push("repairing corrupted entry");
    }
  }

  mcpServers["memory"] = newMemoryEntry;
  const preservedServerCount = Object.keys(mcpServers).length - 1;
  const finalConfig = { ...existingConfig, mcpServers };

  await atomicWrite(configPath, `${JSON.stringify(finalConfig, null, 2)}\n`);

  return { configPath, configCreated, memoryEntryAction, preservedServerCount, log };
}

function isValidMcpEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const record = entry as Record<string, unknown>;
  return (
    typeof record["command"] === "string" &&
    Array.isArray(record["args"]) &&
    record["args"].every((arg) => typeof arg === "string")
  );
}
