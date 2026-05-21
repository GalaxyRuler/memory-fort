import { describe, it, expect } from "vitest";
import { sessionEndBody } from "../../src/hooks/session-end.js";

describe("sessionEndBody", () => {
  const fixedNow = new Date(Date.UTC(2026, 4, 21, 12, 0, 0));

  it("appends a session-end marker via the injected helpers", async () => {
    const calls: any[] = [];
    await sessionEndBody(
      { session_id: "abc", cwd: "C:\\test" },
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
    expect(calls[1].block).toContain("SessionEnd");
    expect(calls[1].block).toContain("12:00:00");
  });

  it("runs even when payload has no special fields", async () => {
    const calls: any[] = [];
    await sessionEndBody(
      {},
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
    expect(calls.length).toBe(2);
    expect(calls[0].tool).toBe("codex");
  });

  it("falls back to 'unknown' session_id when missing", async () => {
    let captured: any = null;
    await sessionEndBody(
      {},
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
