import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDesktopSniffer } from "../../src/sniffers/claude-desktop.js";

describe("ClaudeDesktopSniffer", () => {
  let tmp: string;
  let claudeDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "claude-desktop-sniffer-"));
    claudeDir = join(tmp, "Claude");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports availability from the Claude Desktop data directory", async () => {
    const sniffer = new ClaudeDesktopSniffer({ claudeDir });
    await expect(sniffer.available()).resolves.toBe(false);

    await mkdir(claudeDir, { recursive: true });

    await expect(sniffer.available()).resolves.toBe(true);
  });

  it("parses Claude Desktop JSONL sessions into raw markdown sections", async () => {
    const sessionFile = join(claudeDir, "local-agent-mode-sessions", "desktop-1.jsonl");
    await mkdir(join(claudeDir, "local-agent-mode-sessions"), { recursive: true });
    await writeJsonl(sessionFile, [
      {
        sessionId: "desktop-1",
        timestamp: "2026-05-25T08:00:00.000Z",
        role: "user",
        cwd: "C:/work/memory",
        content: "Summarize today.",
      },
      {
        sessionId: "desktop-1",
        timestamp: "2026-05-25T08:01:00.000Z",
        role: "assistant",
        content: "Here is the summary.",
      },
      {
        sessionId: "desktop-1",
        timestamp: "2026-05-25T08:02:00.000Z",
        type: "tool_use",
        name: "ReadFile",
        input: { path: "notes.md" },
      },
    ]);
    const sniffer = new ClaudeDesktopSniffer({ claudeDir });

    const sessions = await collect(sniffer.list({}));

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      source: "claude-desktop",
      sessionId: "desktop-1",
      startedAt: "2026-05-25T08:00:00.000Z",
      updatedAt: "2026-05-25T08:02:00.000Z",
      cwd: "C:/work/memory",
    });
    expect(sessions[0]!.body).toContain("## [08:00:00] Prompt\n\nSummarize today.");
    expect(sessions[0]!.body).toContain("## [08:01:00] Response\n\nHere is the summary.");
    expect(sessions[0]!.body).toContain("## [08:02:00] ToolUse: ReadFile");
  });

  it("filters supported session files by mtime and honors limit", async () => {
    await mkdir(join(claudeDir, "logs"), { recursive: true });
    const oldFile = join(claudeDir, "logs", "old.jsonl");
    const newFile = join(claudeDir, "logs", "new.jsonl");
    await writeJsonl(oldFile, [entry("old", "2026-05-20T00:00:00.000Z")]);
    await writeJsonl(newFile, [entry("new", "2026-05-25T00:00:00.000Z")]);
    await utimes(oldFile, new Date("2026-05-20T00:00:00.000Z"), new Date("2026-05-20T00:00:00.000Z"));
    await utimes(newFile, new Date("2026-05-25T00:00:00.000Z"), new Date("2026-05-25T00:00:00.000Z"));
    const sniffer = new ClaudeDesktopSniffer({ claudeDir });

    const sessions = await collect(sniffer.list({
      since: new Date("2026-05-22T00:00:00.000Z"),
      limit: 1,
    }));

    expect(sessions.map((session) => session.sessionId)).toEqual(["new"]);
  });

  it("watches supported files and emits reparsed sessions on file growth", async () => {
    const logsDir = join(claudeDir, "logs");
    await mkdir(logsDir, { recursive: true });
    const sessionFile = join(logsDir, "live.jsonl");
    await writeJsonl(sessionFile, [entry("live", "2026-05-26T10:00:00.000Z")]);
    const sniffer = new ClaudeDesktopSniffer({ claudeDir, watchDebounceMs: 10 });

    const captured = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        watcher.close();
        reject(new Error("watch timed out"));
      }, 2000);
      const watcher = sniffer.watch!((session) => {
        if (session.sessionId === "live" && session.body.includes("new desktop turn")) {
          clearTimeout(timeout);
          watcher.close();
          resolve(session.body);
        }
      });
    });

    await appendFile(
      sessionFile,
      JSON.stringify({
        sessionId: "live",
        timestamp: "2026-05-26T10:01:00.000Z",
        role: "assistant",
        content: "new desktop turn",
      }) + "\n",
    );

    await expect(captured).resolves.toContain("new desktop turn");
  });
});

async function writeJsonl(path: string, entries: unknown[]): Promise<void> {
  await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function entry(sessionId: string, timestamp: string): unknown {
  return {
    sessionId,
    timestamp,
    role: "user",
    content: `prompt ${sessionId}`,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
