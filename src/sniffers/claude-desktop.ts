import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { claudeDesktopConfigDir } from "../storage/paths.js";
import { formatTimestamp } from "../hooks/raw-file.js";
import type { Closable, ListOpts, RawSession, Sniffer } from "./types.js";

export interface ClaudeDesktopSnifferOptions {
  claudeDir?: string;
  watchDebounceMs?: number;
}

export class ClaudeDesktopSniffer implements Sniffer {
  name = "claude-desktop";
  private readonly claudeDir: string;
  private readonly watchDebounceMs: number;

  constructor(opts: ClaudeDesktopSnifferOptions = {}) {
    this.claudeDir =
      opts.claudeDir ??
      process.env["MEMORY_CLAUDE_DESKTOP_DIR"] ??
      claudeDesktopConfigDir();
    this.watchDebounceMs = opts.watchDebounceMs ?? 250;
  }

  async available(): Promise<boolean> {
    return existsSync(this.claudeDir);
  }

  async *list(opts: ListOpts = {}): AsyncIterable<RawSession> {
    let yielded = 0;
    for (const filePath of await listSupportedFiles(this.candidateDirs())) {
      const fileStat = await stat(filePath);
      if (opts.since && fileStat.mtime < opts.since) continue;
      yield await parseClaudeDesktopSession(filePath, fileStat.mtime);
      yielded++;
      if (opts.limit !== undefined && yielded >= opts.limit) break;
    }
  }

  watch(handler: (session: RawSession) => void): Closable {
    const watchers: FSWatcher[] = [];
    const timers = new Map<string, NodeJS.Timeout>();
    const seenMtime = new Map<string, number>();

    const schedule = (filePath: string): void => {
      if (!isSupportedSessionFile(filePath)) return;
      const prior = timers.get(filePath);
      if (prior) clearTimeout(prior);
      timers.set(
        filePath,
        setTimeout(async () => {
          timers.delete(filePath);
          try {
            const fileStat = await stat(filePath);
            if (!fileStat.isFile()) return;
            const previous = seenMtime.get(filePath);
            if (previous === fileStat.mtimeMs) return;
            seenMtime.set(filePath, fileStat.mtimeMs);
            handler(await parseClaudeDesktopSession(filePath, fileStat.mtime));
          } catch {
            // The file may still be moving or locked by Claude Desktop.
            // A later change event will retry the parse.
          }
        }, this.watchDebounceMs),
      );
    };

    for (const dir of this.candidateDirs()) {
      if (!existsSync(dir)) continue;
      try {
        watchers.push(
          watch(dir, (_event, filename) => {
            if (!filename) return;
            schedule(join(dir, filename.toString()));
          }),
        );
      } catch {
        // Missing or platform-locked watcher roots are ignored; available()
        // and list() still provide a one-shot import path.
      }
    }

    return {
      close: () => {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        for (const watcher of watchers) watcher.close();
      },
    };
  }

  private candidateDirs(): string[] {
    return uniquePaths([
      this.claudeDir,
      join(this.claudeDir, "logs"),
      join(this.claudeDir, "local-agent-mode-sessions"),
    ]);
  }
}

export async function parseClaudeDesktopSession(
  filePath: string,
  fallbackDate: Date = new Date(),
): Promise<RawSession> {
  const raw = await readFile(filePath, "utf-8");
  const entries = parseEntries(raw, extname(filePath).toLowerCase());
  const timestamps: Date[] = [];
  const sections: string[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;

  for (const entry of entries) {
    const event = normalizeEvent(entry);
    const timestamp = timestampFrom(event) ?? fallbackDate;
    timestamps.push(timestamp);
    sessionId ??= stringField(event, "sessionId") ??
      stringField(event, "session_id") ??
      stringField(event, "conversationId") ??
      stringField(event, "conversation_id") ??
      stringField(event, "id");
    cwd ??= stringField(event, "cwd") ?? stringField(event, "workspace");
    sections.push(...renderEntry(event, timestamp));
  }

  const startedAt = earliestDate(timestamps) ?? fallbackDate;
  const updatedAt = latestDate(timestamps) ?? fallbackDate;
  const fallbackSessionId = basename(filePath).replace(/\.(jsonl|json|log|txt)$/i, "");
  return {
    source: "claude-desktop",
    sessionId: sessionId ?? fallbackSessionId,
    startedAt: startedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    cwd,
    body:
      sections.length > 0
        ? `${sections.join("\n")}\n`
        : `## [${formatTimestamp(fallbackDate)}] Session\n\nNo supported Claude Desktop events found.\n`,
    rawSource: {
      filePath,
      entryCount: entries.length,
    },
  };
}

async function listSupportedFiles(roots: string[]): Promise<string[]> {
  const files = new Set<string>();
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && isSupportedSessionFile(fullPath)) files.add(fullPath);
    }
  }
  for (const root of roots) await walk(root);
  return [...files].sort();
}

function isSupportedSessionFile(filePath: string): boolean {
  return /\.(jsonl|json|log|txt)$/i.test(filePath);
}

function parseEntries(raw: string, extension: string): unknown[] {
  if (extension === ".json") {
    const parsed = tryJson(raw);
    if (Array.isArray(parsed)) return parsed;
    const recordValue = record(parsed);
    for (const key of ["messages", "events", "conversation", "items"]) {
      const value = recordValue[key];
      if (Array.isArray(value)) return value;
    }
    return Object.keys(recordValue).length > 0 ? [recordValue] : [];
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => tryJson(line) ?? { type: "log", content: line });
}

function normalizeEvent(entry: unknown): Record<string, unknown> {
  const outer = record(entry);
  const message = record(outer["message"]);
  if (Object.keys(message).length === 0) return outer;
  return { ...outer, ...message };
}

function renderEntry(event: Record<string, unknown>, timestamp: Date): string[] {
  const type = (stringField(event, "type") ?? "").toLowerCase();
  const role = (stringField(event, "role") ?? "").toLowerCase();
  const content = event["content"] ?? event["text"] ?? event["message"];

  if (role === "user" || role === "human" || type === "prompt" || type === "user") {
    return renderContent(timestamp, "Prompt", content);
  }
  if (
    role === "assistant" ||
    role === "claude" ||
    type === "response" ||
    type === "assistant" ||
    type === "completion"
  ) {
    return renderContent(timestamp, "Response", content);
  }
  if (type === "tool_use" || type === "tool_call" || type === "tool") {
    const name = stringField(event, "name") ?? stringField(event, "toolName") ?? "unknown";
    return [section(timestamp, `ToolUse: ${name}`, jsonBlock(event["input"] ?? event))];
  }
  if (type === "error" || type === "tool_error") {
    return renderContent(timestamp, "ToolError", content ?? event["error"] ?? event);
  }
  if (type === "log") {
    return renderContent(timestamp, "Log", content);
  }
  return renderContent(timestamp, "Event", content ?? event);
}

function renderContent(timestamp: Date, label: string, content: unknown): string[] {
  if (Array.isArray(content)) {
    return content.flatMap((item) => renderEntry(record(item), timestamp));
  }
  const body = stringifyContent(content);
  return body.length > 0 ? [section(timestamp, label, body)] : [];
}

function section(timestamp: Date, label: string, body: string): string {
  return `## [${formatTimestamp(timestamp)}] ${label}\n\n${body}`;
}

function jsonBlock(value: unknown): string {
  return `\`\`\`json\n${safeJsonStringify(value)}\n\`\`\``;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  return safeJsonStringify(value);
}

function tryJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return `[unserializable: ${typeof value}]`;
  }
}

function timestampFrom(event: Record<string, unknown>): Date | null {
  for (const key of ["timestamp", "created_at", "createdAt", "updated_at", "updatedAt", "time"]) {
    const raw = stringField(event, key);
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return null;
}

function earliestDate(dates: Date[]): Date | null {
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function latestDate(dates: Date[]): Date | null {
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}
