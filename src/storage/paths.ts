import { homedir } from "node:os";
import { join } from "node:path";

export type ToolName = "claude-code" | "codex" | "antigravity" | "manual";
export type PageType =
  | "projects"
  | "people"
  | "decisions"
  | "lessons"
  | "references"
  | "tools";

export function memoryRoot(): string {
  const override = process.env["MEMORY_ROOT"];
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".memory");
}

export function schemaPath(): string {
  return join(memoryRoot(), "schema.md");
}

export function indexPath(): string {
  return join(memoryRoot(), "index.md");
}

export function logPath(): string {
  return join(memoryRoot(), "log.md");
}

export function errorsLogPath(): string {
  return join(memoryRoot(), "errors.log");
}

export function configPath(): string {
  return join(memoryRoot(), "config.yaml");
}

export function rawDir(date: Date = new Date()): string {
  return join(memoryRoot(), "raw", formatIsoDate(date));
}

export function rawSessionFile(
  tool: ToolName,
  sessionId: string,
  date: Date = new Date(),
): string {
  // Filename: <tool>-<safeSessionId>.md
  // sessionId is sanitized: anything outside [A-Za-z0-9._-] becomes '_'
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(rawDir(date), `${tool}-${safe}.md`);
}

export function wikiDir(category?: PageType): string {
  const base = join(memoryRoot(), "wiki");
  return category ? join(base, category) : base;
}

export function crystalsDir(): string {
  return join(memoryRoot(), "crystals");
}

export function scriptsDir(): string {
  return join(memoryRoot(), "scripts");
}

export function mcpServerPath(): string {
  return join(scriptsDir(), "mcp-server.mjs");
}

export function formatIsoDate(date: Date): string {
  // YYYY-MM-DD in UTC to avoid TZ drift across machines
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
