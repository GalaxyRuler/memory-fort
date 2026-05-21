import { describe, it, expect } from "vitest";
import { postToolUseBody } from "../../src/hooks/post-tool-use.js";

describe("postToolUseBody", () => {
  const fixedNow = new Date(Date.UTC(2026, 4, 21, 12, 0, 0));

  it("appends a tool-use block via the injected helpers", async () => {
    const calls: any[] = [];
    await postToolUseBody(
      {
        session_id: "abc",
        cwd: "C:\\test",
        tool_name: "Read",
        tool_input: { path: "foo.md" },
        tool_output: "file contents",
      },
      {
        detectTool: () => "claude-code",
        ensureRawSessionFile: async (i) => {
          calls.push({ kind: "ensure", ...i });
          return "/fake/path";
        },
        appendBlock: async (i) => {
          calls.push({ kind: "append", ...i });
        },
        now: () => fixedNow,
      },
    );
    expect(calls[0].kind).toBe("ensure");
    expect(calls[0].sessionId).toBe("abc");
    expect(calls[1].block).toContain("ToolUse: Read");
    expect(calls[1].block).toContain('"path": "foo.md"');
    expect(calls[1].block).toContain("file contents");
  });

  it("skips when tool_name is missing", async () => {
    const calls: any[] = [];
    await postToolUseBody(
      { session_id: "abc", cwd: "C:\\test" },
      {
        detectTool: () => "codex",
        ensureRawSessionFile: async (i) => {
          calls.push({ kind: "ensure", ...i });
          return "/fake/path";
        },
        appendBlock: async (i) => {
          calls.push({ kind: "append", ...i });
        },
      },
    );
    expect(calls.length).toBe(0);
  });

  it("falls back to 'unknown' session_id when missing", async () => {
    let captured: any = null;
    await postToolUseBody(
      { tool_name: "Bash" },
      {
        detectTool: () => "codex",
        ensureRawSessionFile: async (i) => {
          captured = i;
          return "/fake/path";
        },
        appendBlock: async () => {},
        now: () => fixedNow,
      },
    );
    expect(captured.sessionId).toBe("unknown");
    expect(captured.tool).toBe("codex");
  });

  it("accepts Codex-style tool fields", async () => {
    const calls: any[] = [];
    await postToolUseBody(
      {
        turn_id: "turn-456",
        working_directory: "C:\\repo",
        toolName: "Shell",
        toolInput: { command: "echo hi" },
        tool_response: "hi",
      },
      {
        detectTool: () => "codex",
        ensureRawSessionFile: async (i) => {
          calls.push({ kind: "ensure", ...i });
          return "/fake/path";
        },
        appendBlock: async (i) => {
          calls.push({ kind: "append", ...i });
        },
        now: () => fixedNow,
      },
    );
    expect(calls[0].sessionId).toBe("turn-456");
    expect(calls[0].cwd).toBe("C:\\repo");
    expect(calls[1].block).toContain("ToolUse: Shell");
    expect(calls[1].block).toContain('"command": "echo hi"');
    expect(calls[1].block).toContain("hi");
  });
});
