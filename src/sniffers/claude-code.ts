import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { formatTimestamp } from "../hooks/raw-file.js";
import type { ListOpts, RawSession, Sniffer } from "./types.js";

export interface ClaudeCodeSnifferOptions {
  projectsDir?: string;
}

export class ClaudeCodeSniffer implements Sniffer {
  name = "claude-code";
  private readonly projectsDir: string;

  constructor(opts: ClaudeCodeSnifferOptions = {}) {
    this.projectsDir = opts.projectsDir ?? defaultClaudeProjectsDir();
  }

  async available(): Promise<boolean> {
    return existsSync(this.projectsDir);
  }

  async *list(opts: ListOpts = {}): AsyncIterable<RawSession> {
    let yielded = 0;
    for (const filePath of await listJsonlFiles(this.projectsDir)) {
      const fileStat = await stat(filePath);
      if (opts.since && fileStat.mtime < opts.since) continue;
      yield await parseClaudeCodeSession(filePath, fileStat.mtime);
      yielded++;
      if (opts.limit !== undefined && yielded >= opts.limit) break;
    }
  }
}

export async function parseClaudeCodeSession(
  filePath: string,
  fallbackDate: Date = new Date(),
): Promise<RawSession> {
  const sessionId = basename(filePath).replace(/\.jsonl$/i, "");
  const lines = (await readFile(filePath, "utf-8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const entries = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
  const sections: string[] = [];
  const timestamps: Date[] = [];
  let cwd: string | undefined;

  for (const entry of entries) {
    const event = record(entry);
    const timestamp = timestampFrom(event) ?? fallbackDate;
    timestamps.push(timestamp);
    cwd ??= stringField(event, "cwd");
    sections.push(...renderEntry(event, timestamp));
  }

  const startedAt = earliestDate(timestamps) ?? fallbackDate;
  const updatedAt = latestDate(timestamps) ?? fallbackDate;
  return {
    source: "claude-code",
    sessionId,
    startedAt: startedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    cwd,
    body: sections.length > 0
      ? `${sections.join("\n")}\n`
      : `## [${formatTimestamp(fallbackDate)}] Session\n\nNo supported Claude Code events found.\n`,
    rawSource: {
      filePath,
      project: basename(dirname(filePath)),
      lineCount: lines.length,
    },
  };
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  }
  await walk(root);
  return files.sort();
}

function renderEntry(event: Record<string, unknown>, timestamp: Date): string[] {
  const type = stringField(event, "type");
  const message = record(event["message"]);
  const content = message["content"] ?? event["content"];
  if (type === "user") return renderUserContent(content, timestamp);
  if (type === "assistant") return renderAssistantContent(content, timestamp);
  return [];
}

function renderUserContent(content: unknown, timestamp: Date): string[] {
  if (typeof content === "string" && content.trim().length > 0) {
    return [section(timestamp, "Prompt", content.trim())];
  }
  if (!Array.isArray(content)) return [];
  const sections: string[] = [];
  for (const item of content) {
    const block = record(item);
    const type = stringField(block, "type");
    if (type === "tool_result") {
      const id = stringField(block, "tool_use_id") ?? stringField(block, "id") ?? "unknown";
      sections.push(section(timestamp, `ToolResult: ${id}`, stringifyContent(block["content"])));
    } else if (type === "text") {
      sections.push(section(timestamp, "Prompt", stringifyContent(block["text"])));
    }
  }
  return sections;
}

function renderAssistantContent(content: unknown, timestamp: Date): string[] {
  if (typeof content === "string" && content.trim().length > 0) {
    return [section(timestamp, "Response", content.trim())];
  }
  if (!Array.isArray(content)) return [];
  const sections: string[] = [];
  for (const item of content) {
    const block = record(item);
    const type = stringField(block, "type");
    if (type === "text") {
      sections.push(section(timestamp, "Response", stringifyContent(block["text"])));
    } else if (type === "thinking") {
      sections.push(section(timestamp, "Thinking", stringifyContent(block["thinking"] ?? block["text"])));
    } else if (type === "tool_use") {
      const name = stringField(block, "name") ?? "unknown";
      sections.push(section(timestamp, `ToolUse: ${name}`, jsonBlock(block["input"])));
    }
  }
  return sections;
}

function section(timestamp: Date, label: string, body: string): string {
  return `## [${formatTimestamp(timestamp)}] ${label}\n\n${body}`;
}

function jsonBlock(value: unknown): string {
  return `\`\`\`json\n${safeJsonStringify(value)}\n\`\`\``;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return safeJsonStringify(value);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return `[unserializable: ${typeof value}]`;
  }
}

function timestampFrom(event: Record<string, unknown>): Date | null {
  const raw = stringField(event, "timestamp");
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
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

function defaultClaudeProjectsDir(): string {
  const override = process.env["MEMORY_CLAUDE_PROJECTS_DIR"];
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".claude", "projects");
}
