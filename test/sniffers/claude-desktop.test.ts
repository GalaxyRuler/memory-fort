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

  it("imports only session dirs — never the Claude root, logs/, or signal-less JSON", async () => {
    await mkdir(join(claudeDir, "logs"), { recursive: true });
    await mkdir(join(claudeDir, "claude-code-sessions", "nested"), { recursive: true });
    await mkdir(join(claudeDir, "local-agent-mode-sessions", "skills-plugin"), { recursive: true });
    // Root files include credential-adjacent material (oauth:tokenCache) and
    // app resources; a root walk once imported 1282 junk files into the vault,
    // and hourly logs/ imports rewrote ~0.9GB/day of telemetry.
    await writeFile(join(claudeDir, "claude_desktop_config.json"), '{"oauth:tokenCache":"secret-blob"}');
    await writeFile(join(claudeDir, "buddy-tokens.json"), '{"tokens-today":{}}');
    await writeFile(join(claudeDir, "logs", "main.log"), '{"sessionId":"log-1","timestamp":"2026-05-25T08:00:00.000Z","content":"log line"}\n');
    // Signal-less JSON inside a session dir (plugin manifest) must be skipped.
    await writeFile(join(claudeDir, "local-agent-mode-sessions", "skills-plugin", "manifest.json"), '{"name":"skills","version":"1.0.0"}');
    await writeFile(join(claudeDir, "claude-code-sessions", "cc-1.jsonl"), '{"sessionId":"cc-1","timestamp":"2026-05-25T08:00:00.000Z","content":"cc line"}\n');
    // Same basename in different dirs must not collapse onto one capture id.
    await writeFile(join(claudeDir, "claude-code-sessions", "nested", "session.jsonl"), '{"timestamp":"2026-05-25T09:00:00.000Z","role":"user","content":"nested a"}\n');
    await writeFile(join(claudeDir, "local-agent-mode-sessions", "session.jsonl"), '{"timestamp":"2026-05-25T09:00:00.000Z","role":"user","content":"top b"}\n');

    const sniffer = new ClaudeDesktopSniffer({ claudeDir });
    const sessions: string[] = [];
    for await (const session of sniffer.list({})) sessions.push(session.sessionId);

    expect(sessions).toContain("cc-1");
    expect(sessions).not.toContain("log-1");
    expect(sessions.join(",")).not.toContain("manifest");
    const fallbackIds = sessions.filter((id) => id.startsWith("session-"));
    expect(fallbackIds).toHaveLength(2);
    expect(new Set(fallbackIds).size).toBe(2);
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
    await mkdir(join(claudeDir, "local-agent-mode-sessions"), { recursive: true });
    const oldFile = join(claudeDir, "local-agent-mode-sessions", "old.jsonl");
    const newFile = join(claudeDir, "local-agent-mode-sessions", "new.jsonl");
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
    const logsDir = join(claudeDir, "local-agent-mode-sessions");
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
