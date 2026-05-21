import { describe, it, expect } from "vitest";
import { promptSubmitBody } from "../../src/hooks/prompt-submit.js";

describe("promptSubmitBody", () => {
  const fixedNow = new Date(Date.UTC(2026, 4, 21, 12, 0, 0));

  it("appends a prompt block via the injected helpers", async () => {
    const calls: any[] = [];
    await promptSubmitBody(
      { session_id: "abc", cwd: "C:\\test", prompt: "hello world" },
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
    expect(calls[0].tool).toBe("claude-code");
    expect(calls[0].sessionId).toBe("abc");
    expect(calls[1].kind).toBe("append");
    expect(calls[1].block).toContain("hello world");
    expect(calls[1].block).toContain("12:00:00");
  });

  it("skips when prompt is empty/whitespace", async () => {
    const calls: any[] = [];
    await promptSubmitBody(
      { session_id: "abc", cwd: "C:\\test", prompt: "   " },
      {
        detectTool: () => "claude-code",
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
    await promptSubmitBody(
      { prompt: "x" },
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
});
