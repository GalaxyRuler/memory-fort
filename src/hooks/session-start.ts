import { readFile } from "node:fs/promises";
import { runHook, type HookPayload } from "./error-handler.js";
import { detectTool } from "./util/detect-tool.js";
import {
  confidenceAwareIndex,
  currentProjectMemoryBlock,
  whatToRememberBlock,
} from "./session-start-helpers.js";
import { schemaPath, indexPath, logPath, memoryRoot } from "../storage/paths.js";
import { isClientEnabled, loadMemoryConfig, type MemoryConfig } from "../storage/config.js";

export interface SessionStartDeps {
  readFile?: (path: string) => Promise<string>;
  write?: (text: string) => void;
  memoryRoot?: string;
  maxInjectedChars?: number;
  detectTool?: typeof detectTool;
  configLoader?: (root: string) => Promise<MemoryConfig>;
}

/**
 * Phase 1 session-start: emit a plain text context block to
 * stdout containing schema.md + index.md + last 20 log.md lines.
 * Platform-specific output framing (JSON envelopes, structured
 * fields) deferred to Phase 2 if needed — Phase 1 plain text
 * works for Claude Code and Codex out of the box. Antigravity
 * live capture uses its own plugin hook scripts, so this shared
 * script never runs there.
 */
export async function sessionStartBody(
  payload: HookPayload,
  deps: SessionStartDeps = {},
): Promise<void> {
  const readFn =
    deps.readFile ??
    (async (p: string) => readFile(p, "utf-8"));
  const writeFn =
    deps.write ?? ((text: string) => process.stdout.write(text));

  if (await shouldSkipForDisabledClient(payload, deps)) return;

  const parts: string[] = [];
  parts.push(`[memory:session-start] context loading\n`);

  try {
    const projectBlock = await currentProjectMemoryBlock({
      cwd: readPayloadCwd(payload),
      memoryRoot: deps.memoryRoot ?? memoryRoot(),
      readFile: readFn,
      maxChars: deps.maxInjectedChars,
    });
    if (projectBlock && projectBlock.trim().length > 0) {
      parts.push(`\n${projectBlock.trim()}\n`);
    }
  } catch {
    // Project memory is opportunistic; preserve the legacy schema/index/log output.
  }

  const sections: Array<{
    label: string;
    path: string;
    tail?: number;
    confidenceAware?: boolean;
  }> = [
    { label: "Schema", path: schemaPath() },
    { label: "Index", path: indexPath(), confidenceAware: true },
    { label: "Recent log", path: logPath(), tail: 20 },
  ];

  for (const sec of sections) {
    try {
      const content = sec.confidenceAware
        ? await confidenceAwareIndex({ indexFilePath: sec.path, readFile: readFn })
        : await readFn(sec.path);
      const body = sec.tail ? lastLines(content, sec.tail) : content;
      parts.push(`\n--- ${sec.label} (${sec.path}) ---\n${body.trim()}\n`);
    } catch {
      // Missing file is normal on fresh installs; skip silently
    }
  }

  const remember = await whatToRememberBlock({ readFile: readFn });
  if (remember.trim().length > 0) {
    parts.push(`\n${remember}`);
  }

  writeFn(parts.join(""));
}

async function shouldSkipForDisabledClient(
  payload: HookPayload,
  deps: SessionStartDeps,
): Promise<boolean> {
  const shouldReadConfig = deps.configLoader !== undefined ||
    (deps.readFile === undefined && deps.write === undefined);
  if (!shouldReadConfig) return false;
  const root = deps.memoryRoot ?? memoryRoot();
  const config = await (deps.configLoader ?? loadMemoryConfig)(root);
  const tool = (deps.detectTool ?? detectTool)({ payload });
  return !isClientEnabled(config, tool);
}

function lastLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function readPayloadCwd(payload: HookPayload): string | null {
  if (typeof payload.cwd === "string" && payload.cwd.trim().length > 0) return payload.cwd;
  if (
    typeof payload.working_directory === "string" &&
    payload.working_directory.trim().length > 0
  ) {
    return payload.working_directory;
  }
  return null;
}

if (process.argv[1]?.endsWith("session-start.mjs")) {
  runHook({ hookName: "session-start", body: sessionStartBody });
}
