import { existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite } from "../../../storage/atomic-write.js";
import {
  claudeDesktopConfigPath,
  mcpServerPath,
} from "../../../storage/paths.js";

export interface InstallClaudeDesktopResult {
  configPath: string;
  configCreated: boolean;
  memoryEntryAction: "created" | "updated" | "unchanged";
  preservedServerCount: number;
}

export async function runInstallClaudeDesktop(): Promise<InstallClaudeDesktopResult> {
  const configPath = claudeDesktopConfigPath();
  let existingConfig: Record<string, unknown> = {};
  let configCreated = false;

  if (existsSync(configPath)) {
    const raw = await readFile(configPath, "utf-8");
    try {
      existingConfig = JSON.parse(raw) as Record<string, unknown>;
      if (typeof existingConfig !== "object" || existingConfig === null) {
        existingConfig = {};
      }
    } catch (err) {
      throw new Error(
        `memory install claude-desktop: failed to parse existing config at ${configPath}: ${(err as Error).message}`,
      );
    }
  } else {
    configCreated = true;
    await mkdir(dirname(configPath), { recursive: true });
  }

  const existingServers = existingConfig["mcpServers"];
  const mcpServers: Record<string, unknown> =
    typeof existingServers === "object" && existingServers !== null
      ? { ...(existingServers as Record<string, unknown>) }
      : {};

  const newMemoryEntry = {
    command: "node",
    args: [mcpServerPath().replace(/\\/g, "/")],
  };

  const existingMemory = mcpServers["memory"];
  let memoryEntryAction: "created" | "updated" | "unchanged";
  if (existingMemory === undefined) {
    memoryEntryAction = "created";
  } else if (JSON.stringify(existingMemory) === JSON.stringify(newMemoryEntry)) {
    memoryEntryAction = "unchanged";
  } else {
    memoryEntryAction = "updated";
  }

  mcpServers["memory"] = newMemoryEntry;
  const preservedServerCount = Object.keys(mcpServers).length - 1;
  const finalConfig = { ...existingConfig, mcpServers };

  await atomicWrite(configPath, JSON.stringify(finalConfig, null, 2) + "\n");

  return { configPath, configCreated, memoryEntryAction, preservedServerCount };
}
