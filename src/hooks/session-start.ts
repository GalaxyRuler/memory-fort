import { readFile } from "node:fs/promises";
import { runHook, type HookPayload } from "./error-handler.js";
import { confidenceAwareIndex, whatToRememberBlock } from "./session-start-helpers.js";
import { schemaPath, indexPath, logPath } from "../storage/paths.js";

export interface SessionStartDeps {
  readFile?: (path: string) => Promise<string>;
  write?: (text: string) => void;
}

/**
 * Phase 1 session-start: emit a plain text context block to
 * stdout containing schema.md + index.md + last 20 log.md lines.
 * Platform-specific output framing (JSON envelopes, structured
 * fields) deferred to Phase 2 if needed — Phase 1 plain text
 * works for Claude Code and Codex out of the box; Antigravity
 * has no hooks so this script never runs there.
 */
export async function sessionStartBody(
  payload: HookPayload,
  deps: SessionStartDeps = {},
): Promise<void> {
  void payload;
  const readFn =
    deps.readFile ??
    (async (p: string) => readFile(p, "utf-8"));
  const writeFn =
    deps.write ?? ((text: string) => process.stdout.write(text));

  const parts: string[] = [];
  parts.push(`[memory:session-start] context loading\n`);

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

function lastLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

if (process.argv[1]?.endsWith("session-start.mjs")) {
  runHook({ hookName: "session-start", body: sessionStartBody });
}
