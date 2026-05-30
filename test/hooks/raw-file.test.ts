import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatTimestamp,
  formatPromptBlock,
  formatToolUseBlock,
  formatMarker,
  truncate,
  truncateMiddle,
  ensureRawSessionFile,
  appendBlock,
} from "../../src/hooks/raw-file.js";

describe("raw-file formatters", () => {
  const t = new Date(Date.UTC(2026, 4, 21, 9, 8, 7));

  it("formatTimestamp returns HH:MM:SS in UTC", () => {
    expect(formatTimestamp(t)).toBe("09:08:07");
  });

  it("formatPromptBlock contains heading + content + timestamp", () => {
    const out = formatPromptBlock("hello world", t);
    expect(out).toContain("## [09:08:07] Prompt");
    expect(out).toContain("hello world");
  });

  it("formatPromptBlock trims surrounding whitespace from prompt", () => {
    const out = formatPromptBlock("   spaced   ", t);
    expect(out).toContain("spaced");
    expect(out).not.toContain("   spaced");
  });

  it("formatToolUseBlock includes tool name, input JSON, output", () => {
    const out = formatToolUseBlock({
      toolName: "Read",
      toolInput: { path: "foo.md" },
      toolOutput: "file contents",
      now: t,
    });
    expect(out).toContain("## [09:08:07] ToolUse: Read");
    expect(out).toContain('"path": "foo.md"');
    expect(out).toContain("file contents");
  });

  it("formatToolUseBlock truncates output beyond maxOutputBytes", () => {
    const longOutput = `output-head-${"x".repeat(10000)}-output-tail`;
    const out = formatToolUseBlock({
      toolName: "Bash",
      toolInput: {},
      toolOutput: longOutput,
      now: t,
      maxOutputBytes: 100,
    });
    expect(out).toContain("bytes elided");
    expect(out).toContain("output-head");
    expect(out).toContain("output-tail");
    expect(out.length).toBeLessThan(1000);
  });

  it("formatToolUseBlock truncates large input with head and tail preserved", () => {
    const out = formatToolUseBlock({
      toolName: "apply_patch",
      toolInput: {
        patch: `input-head-${"x".repeat(30_000)}-input-tail`,
      },
      toolOutput: "ok",
      now: t,
      maxInputBytes: 400,
      maxOutputBytes: 400,
    });

    expect(Buffer.byteLength(out, "utf-8")).toBeLessThan(1_200);
    expect(out).toContain("input-head");
    expect(out).toContain("input-tail");
    expect(out).toContain("bytes elided");
  });

  it("formatMarker includes label and timestamp with horizontal rule", () => {
    const out = formatMarker("SessionEnd", t);
    expect(out).toContain("## [09:08:07] SessionEnd");
    expect(out).toContain("---");
  });

  it("truncate returns input unchanged when under limit", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("truncate adds marker when over limit", () => {
    const result = truncate("x".repeat(1000), 50);
    expect(result).toContain("[truncated to 50 bytes]");
  });

  it("truncateMiddle preserves head and tail within the byte limit", () => {
    const result = truncateMiddle(`alpha-${"x".repeat(1000)}-omega`, 120);

    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(120);
    expect(result).toContain("alpha");
    expect(result).toContain("omega");
    expect(result).toContain("bytes elided");
  });

  it("truncateMiddle is UTF-8 boundary safe", () => {
    const result = truncateMiddle(`🙂-${"中".repeat(200)}-🙃`, 80);

    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(80);
    expect(result).not.toContain("\uFFFD");
  });

  it("truncateMiddle returns input unchanged when under limit", () => {
    expect(truncateMiddle("hello", 100)).toBe("hello");
  });
});

describe("raw-file I/O", () => {
  let tmp: string;
  let oldRoot: string | undefined;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memtest-rawfile-"));
    oldRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
  });
  afterEach(async () => {
    if (oldRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = oldRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  it("ensureRawSessionFile creates file with frontmatter on first call", async () => {
    const t = new Date(Date.UTC(2026, 4, 21));
    const path = await ensureRawSessionFile({
      tool: "claude-code",
      sessionId: "abc-123",
      cwd: "C:\\test",
      now: t,
    });
    const content = await readFile(path, "utf-8");
    expect(content).toContain("type: raw-session");
    expect(content).toContain("source: claude-code");
    expect(content).toContain('session: "abc-123"');
    expect(content).toContain('created: "2026-05-21"');
  });

  it("ensureRawSessionFile is idempotent - second call does not overwrite", async () => {
    const t = new Date(Date.UTC(2026, 4, 21));
    const path = await ensureRawSessionFile({
      tool: "claude-code",
      sessionId: "abc-123",
      cwd: "C:\\test",
      now: t,
    });
    const first = await readFile(path, "utf-8");
    await ensureRawSessionFile({
      tool: "claude-code",
      sessionId: "abc-123",
      cwd: "C:\\test-different",
      now: new Date(Date.UTC(2026, 4, 21, 23)),
    });
    const second = await readFile(path, "utf-8");
    expect(second).toBe(first);
  });

  it("appendBlock appends to existing session file", async () => {
    const t = new Date(Date.UTC(2026, 4, 21));
    const path = await ensureRawSessionFile({
      tool: "claude-code",
      sessionId: "abc-123",
      cwd: "C:\\test",
      now: t,
    });
    await appendBlock({
      tool: "claude-code",
      sessionId: "abc-123",
      block: "\n## [09:00:00] Prompt\n\nhello\n",
      now: t,
    });
    const content = await readFile(path, "utf-8");
    expect(content).toContain("type: raw-session");
    expect(content).toContain("## [09:00:00] Prompt");
    expect(content).toContain("hello");
  });
});
