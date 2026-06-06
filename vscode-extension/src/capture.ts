import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CaptureTurn {
  sessionId: string;
  prompt?: string;
  response?: string;
  cwd?: string;
  timestamp?: Date;
}

export function captureTurn(turn: CaptureTurn): string {
  const timestamp = turn.timestamp ?? new Date();
  const root = process.env.MEMORY_ROOT ?? join(homedir(), ".memory");
  const sessionId = safeName(turn.sessionId || "vscode");
  const file = join(root, "raw", isoDate(timestamp), `vscode-${sessionId}.md`);
  ensureFile(file, turn, timestamp);

  const time = timestamp.toISOString().slice(11, 19);
  if (turn.prompt?.trim()) {
    appendFileSync(file, `\n## [${time}] Prompt\n\n${turn.prompt.trim()}\n`, "utf-8");
  }
  if (turn.response?.trim()) {
    appendFileSync(file, `\n## [${time}] Response\n\n${turn.response.trim()}\n`, "utf-8");
  }
  return file;
}

function ensureFile(file: string, turn: CaptureTurn, timestamp: Date): void {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  const frontmatter = [
    "---",
    "source: vscode",
    `session_id: ${turn.sessionId}`,
    `created: ${isoDate(timestamp)}`,
    `updated: ${isoDate(timestamp)}`,
    turn.cwd ? `cwd: "${turn.cwd.replace(/"/g, '\\"')}"` : null,
    "---",
    "",
    `# VS Code Chat Session ${turn.sessionId}`,
    "",
  ].filter(Boolean).join("\n");
  writeFileSync(file, frontmatter, "utf-8");
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "vscode";
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
