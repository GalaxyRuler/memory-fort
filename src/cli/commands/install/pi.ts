import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicAppend, atomicWrite } from "../../../storage/atomic-write.js";
import { logPath, memoryRoot } from "../../../storage/paths.js";
import { stripPriorBlock } from "./codex.js";

export interface InstallPiOptions {
  piDir?: string;
  now?: Date;
}

export interface InstallPiResult {
  configPath: string;
  configCreated: boolean;
  priorBlockReplaced: boolean;
  log: string[];
}

const VERSION = "0.1.0";

export async function runInstallPi(
  opts: InstallPiOptions = {},
): Promise<InstallPiResult> {
  const piDir = opts.piDir ?? process.env["MEMORY_PI_DIR"] ?? join(homedir(), ".pi");
  const configPath = join(piDir, "config.yaml");
  const log: string[] = [];
  let existing = "";
  let configCreated = false;

  if (existsSync(configPath)) {
    existing = await readFile(configPath, "utf-8");
  } else {
    configCreated = true;
  }

  const { content: cleaned, replaced: priorBlockReplaced } = stripPriorBlock(existing);
  const priorTrailingNewlines = countTrailingNewlines(cleaned);
  const prefix = cleaned.length > 0 && !cleaned.endsWith("\n") ? `${cleaned}\n` : cleaned;
  const sep = cleaned.length > 0 ? "\n" : "";
  const newContent = `${prefix}${sep}${renderPiBlock(priorTrailingNewlines)}`;

  await atomicWrite(configPath, newContent);
  log.push(
    configCreated
      ? `created ${configPath} with memory-system block`
      : priorBlockReplaced
        ? `replaced existing memory-system block in ${configPath}`
        : `appended memory-system block to ${configPath} (no prior block)`,
  );
  log.push("Pi MCP support varies; skipped MCP config for v1");

  const now = opts.now ?? new Date();
  await atomicAppend(
    logPath(),
    `## [${now.toISOString()}] install | pi: hooks in ${configPath} (MCP skipped)\n`,
  );

  return { configPath, configCreated, priorBlockReplaced, log };
}

function renderPiBlock(priorTrailingNewlines: number): string {
  const root = memoryRoot().replace(/\\/g, "/");
  return [
    `# === BEGIN memory-system v${VERSION} ===`,
    `# DO NOT EDIT - managed by 'memory install pi'. Re-run install to update.`,
    `# prior_trailing_newlines = ${priorTrailingNewlines}`,
    ``,
    `hooks:`,
    `  session_start:`,
    `    type: command`,
    `    command: "node ${root}/hooks/session-start.mjs"`,
    `  session_end:`,
    `    type: command`,
    `    command: "node ${root}/hooks/session-end.mjs"`,
    ``,
    `# === END memory-system v${VERSION} ===`,
    ``,
  ].join("\n");
}

function countTrailingNewlines(content: string): number {
  return /\n*$/u.exec(content)?.[0].length ?? 0;
}
