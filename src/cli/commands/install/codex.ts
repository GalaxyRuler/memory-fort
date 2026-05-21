import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { memoryRoot, logPath } from "../../../storage/paths.js";
import { atomicWrite, atomicAppend } from "../../../storage/atomic-write.js";

export interface InstallCodexOptions {
  /** Override `~/.codex/` (default: homedir + '.codex'). */
  codexDir?: string;
  /** For tests. */
  now?: Date;
}

export interface InstallCodexResult {
  codexConfigPath: string;
  configCreated: boolean;
  priorBlockReplaced: boolean;
  log: string[];
}

const VERSION = "0.1.0";
const BEGIN_MARKER_RE = /^# === BEGIN memory-system v[^\s=]+ ===\s*$/m;
const END_MARKER_RE = /^# === END memory-system v[^\s=]+ ===\s*$/m;

function pluginScriptsAbs(): string {
  return join(memoryRoot(), "claude-code-plugin", "scripts").replace(/\\/g, "/");
}

function renderBlock(): string {
  const scripts = pluginScriptsAbs();
  const mcpServerPath = `${scripts}/mcp-server.mjs`;
  return [
    `# === BEGIN memory-system v${VERSION} ===`,
    `# DO NOT EDIT — managed by 'memory install codex'. Re-run install to update.`,
    ``,
    `[[hooks.SessionStart]]`,
    `matcher = "startup|resume"`,
    ``,
    `[[hooks.SessionStart.hooks]]`,
    `type = "command"`,
    `command = "node ${scripts}/session-start.mjs"`,
    ``,
    `[[hooks.UserPromptSubmit]]`,
    ``,
    `[[hooks.UserPromptSubmit.hooks]]`,
    `type = "command"`,
    `command = "node ${scripts}/prompt-submit.mjs"`,
    ``,
    `[[hooks.PostToolUse]]`,
    ``,
    `[[hooks.PostToolUse.hooks]]`,
    `type = "command"`,
    `command = "node ${scripts}/post-tool-use.mjs"`,
    ``,
    `[[hooks.PreCompact]]`,
    ``,
    `[[hooks.PreCompact.hooks]]`,
    `type = "command"`,
    `command = "node ${scripts}/pre-compact.mjs"`,
    ``,
    `[[hooks.Stop]]`,
    ``,
    `[[hooks.Stop.hooks]]`,
    `type = "command"`,
    `command = "node ${scripts}/session-end.mjs"`,
    ``,
    `[mcp_servers.memory]`,
    `command = "node"`,
    `args = ["${mcpServerPath}"]`,
    ``,
    `# === END memory-system v${VERSION} ===`,
    ``,
  ].join("\n");
}

/**
 * Remove any prior `# === BEGIN memory-system ... ===` ...
 * `# === END memory-system ... ===` block from existing config
 * content. Returns the cleaned content + a boolean indicating
 * whether a prior block was found and removed.
 */
export function stripPriorBlock(existing: string): {
  content: string;
  replaced: boolean;
} {
  const beginMatch = BEGIN_MARKER_RE.exec(existing);
  if (!beginMatch) return { content: existing, replaced: false };
  const endMatch = END_MARKER_RE.exec(existing.slice(beginMatch.index));
  if (!endMatch) {
    return { content: existing, replaced: false };
  }

  const endAbsoluteIndex = beginMatch.index + endMatch.index + endMatch[0].length;
  const after = existing.slice(endAbsoluteIndex);
  const cleaned = existing.slice(0, beginMatch.index) + after.replace(/^\n/, "");
  return { content: cleaned, replaced: true };
}

export async function installCodex(
  opts: InstallCodexOptions = {},
): Promise<InstallCodexResult> {
  const codexDir =
    opts.codexDir ?? process.env["MEMORY_CODEX_DIR"] ?? join(homedir(), ".codex");
  const configPath = join(codexDir, "config.toml");

  const log: string[] = [];
  let existing = "";
  let configCreated = false;
  if (existsSync(configPath)) {
    existing = await readFile(configPath, "utf-8");
  } else {
    configCreated = true;
  }

  const { content: cleaned, replaced: priorBlockReplaced } =
    stripPriorBlock(existing);
  const prefix =
    cleaned.length > 0 && !cleaned.endsWith("\n") ? `${cleaned}\n` : cleaned;
  const sep = cleaned.length > 0 ? "\n" : "";
  const newContent = `${prefix}${sep}${renderBlock()}`;

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
    `## [${now.toISOString()}] install | codex: hooks + MCP in ${configPath}\n`,
  );

  return { codexConfigPath: configPath, configCreated, priorBlockReplaced, log };
}
