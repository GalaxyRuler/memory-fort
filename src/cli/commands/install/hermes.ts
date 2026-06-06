import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicAppend, atomicWrite } from "../../../storage/atomic-write.js";
import { logPath, memoryRoot } from "../../../storage/paths.js";
import { stripPriorBlock } from "./codex.js";

export interface InstallHermesOptions {
  hermesDir?: string;
  now?: Date;
}

export interface InstallHermesResult {
  configPath: string;
  configCreated: boolean;
  priorBlockReplaced: boolean;
  log: string[];
}

const VERSION = "0.1.0";

export async function runInstallHermes(
  opts: InstallHermesOptions = {},
): Promise<InstallHermesResult> {
  const hermesDir =
    opts.hermesDir ?? process.env["MEMORY_HERMES_DIR"] ?? join(homedir(), ".hermes");
  const configPath = join(hermesDir, "config.yaml");
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
  const newContent = `${prefix}${sep}${renderHermesBlock(priorTrailingNewlines)}`;

  await atomicWrite(configPath, newContent);
  log.push(
    configCreated
      ? `created ${configPath} with memory-system block`
      : priorBlockReplaced
        ? `replaced existing memory-system block in ${configPath}`
        : `appended memory-system block to ${configPath} (no prior block)`,
  );

  const now = opts.now ?? new Date();
  await atomicAppend(
    logPath(),
    `## [${now.toISOString()}] install | hermes: hooks + MCP in ${configPath}\n`,
  );

  return { configPath, configCreated, priorBlockReplaced, log };
}

function renderHermesBlock(priorTrailingNewlines: number): string {
  const root = memoryRoot().replace(/\\/g, "/");
  return [
    `# === BEGIN memory-system v${VERSION} ===`,
    `# DO NOT EDIT - managed by 'memory install hermes'. Re-run install to update.`,
    `# prior_trailing_newlines = ${priorTrailingNewlines}`,
    ``,
    `hooks:`,
    `  on_session_start: "node ${root}/hooks/session-start.mjs"`,
    `  on_session_end: "node ${root}/hooks/session-end.mjs"`,
    `mcp_servers:`,
    `  memory:`,
    `    command: node`,
    `    args: ["${root}/hooks/mcp-server.mjs"]`,
    ``,
    `# === END memory-system v${VERSION} ===`,
    ``,
  ].join("\n");
}

function countTrailingNewlines(content: string): number {
  return /\n*$/u.exec(content)?.[0].length ?? 0;
}
