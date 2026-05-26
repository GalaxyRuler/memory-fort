import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeSniffer } from "../../src/sniffers/claude-code.js";

describe("ClaudeCodeSniffer", () => {
  let tmp: string;
  let projectsDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "claude-code-sniffer-"));
    projectsDir = join(tmp, ".claude", "projects");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports availability from the Claude projects directory", async () => {
    const sniffer = new ClaudeCodeSniffer({ projectsDir });
    await expect(sniffer.available()).resolves.toBe(false);

    await mkdir(projectsDir, { recursive: true });

    await expect(sniffer.available()).resolves.toBe(true);
  });

  it("parses Claude Code JSONL sessions into raw markdown sections", async () => {
    const sessionFile = join(projectsDir, "C--work--demo", "abc-123.jsonl");
    await mkdir(join(projectsDir, "C--work--demo"), { recursive: true });
    await writeJsonl(sessionFile, [
      {
        type: "user",
        timestamp: "2026-05-24T10:00:00.000Z",
        sessionId: "abc-123",
        cwd: "C:/work/demo",
        message: { role: "user", content: "Build the parser." },
      },
      {
        type: "assistant",
        timestamp: "2026-05-24T10:01:00.000Z",
        sessionId: "abc-123",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect the JSONL." },
            { type: "tool_use", name: "Read", input: { file_path: "session.jsonl" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-05-24T10:02:00.000Z",
        sessionId: "abc-123",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "file contents" },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-05-24T10:03:00.000Z",
        sessionId: "abc-123",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "private scratch" }],
        },
      },
    ]);
    const sniffer = new ClaudeCodeSniffer({ projectsDir });

    const sessions = await collect(sniffer.list({}));

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      source: "claude-code",
      sessionId: "abc-123",
      startedAt: "2026-05-24T10:00:00.000Z",
      updatedAt: "2026-05-24T10:03:00.000Z",
      cwd: "C:/work/demo",
    });
    expect(sessions[0]!.body).toContain("## [10:00:00] Prompt\n\nBuild the parser.");
    expect(sessions[0]!.body).toContain("## [10:01:00] Response\n\nI will inspect the JSONL.");
    expect(sessions[0]!.body).toContain("## [10:01:00] ToolUse: Read");
    expect(sessions[0]!.body).toContain('"file_path": "session.jsonl"');
    expect(sessions[0]!.body).toContain("## [10:02:00] ToolResult: toolu_1");
    expect(sessions[0]!.body).toContain("## [10:03:00] Thinking");
  });

  it("filters by file mtime and honors limit", async () => {
    await mkdir(join(projectsDir, "project"), { recursive: true });
    const oldFile = join(projectsDir, "project", "old.jsonl");
    const newFile = join(projectsDir, "project", "new.jsonl");
    await writeJsonl(oldFile, [entry("old", "2026-05-20T00:00:00.000Z")]);
    await writeJsonl(newFile, [entry("new", "2026-05-25T00:00:00.000Z")]);
    await utimes(oldFile, new Date("2026-05-20T00:00:00.000Z"), new Date("2026-05-20T00:00:00.000Z"));
    await utimes(newFile, new Date("2026-05-25T00:00:00.000Z"), new Date("2026-05-25T00:00:00.000Z"));
    const sniffer = new ClaudeCodeSniffer({ projectsDir });

    const sessions = await collect(sniffer.list({
      since: new Date("2026-05-22T00:00:00.000Z"),
      limit: 1,
    }));

    expect(sessions.map((session) => session.sessionId)).toEqual(["new"]);
  });
});

async function writeJsonl(path: string, entries: unknown[]): Promise<void> {
  await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function entry(sessionId: string, timestamp: string): unknown {
  return {
    type: "user",
    timestamp,
    sessionId,
    message: { role: "user", content: `prompt ${sessionId}` },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
