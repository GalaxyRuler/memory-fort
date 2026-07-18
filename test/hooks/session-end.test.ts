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

  it("runs auto-link once for the session raw file and logs failures without throwing", async () => {
    const calls: string[] = [];
    await sessionEndBody(
      { session_id: "abc", cwd: "C:\\test" },
      {
        detectTool: () => "codex",
        ensureRawSessionFile: async () => {
          calls.push("ensure");
          return "raw/2026-05-21/codex-abc.md";
        },
        appendBlock: async () => {
          calls.push("append");
        },
        autoLinkRawToWiki: (async (rawPath: string) => {
          calls.push(`auto-link:${rawPath}`);
          throw new Error("linker unavailable");
        }) as never,
        appendErrorLog: async (line: string) => {
          calls.push(`error:${line}`);
        },
        configLoader: async () => ({ auto_link: { enabled: true, similarity_threshold: 0.75 } }),
        now: () => fixedNow,
      },
    );
    expect(calls[0]).toBe("ensure");
    expect(calls[1]).toBe("append");
    expect(calls[2]).toBe("auto-link:raw/2026-05-21/codex-abc.md");
    expect(calls[3]).toContain("auto-link failed");
    expect(calls[3]).toContain("linker unavailable");
  });

  it("runs auto-heal once after the session-end marker when enabled", async () => {
    const calls: string[] = [];
    await sessionEndBody(
      { session_id: "abc", cwd: "C:\\test" },
      {
        detectTool: () => "codex",
        ensureRawSessionFile: async () => {
          calls.push("ensure");
          return "raw/2026-05-21/codex-abc.md";
        },
        appendBlock: async () => {
          calls.push("append");
        },
        autoHealRaw: (async (input: { relPath: string }) => {
          calls.push(`auto-heal:${input.relPath}`);
        }) as never,
        configLoader: async () => ({ auto_heal: { enabled: true }, auto_link: { enabled: false } }),
        now: () => fixedNow,
      },
    );
    expect(calls).toEqual([
      "ensure",
      "append",
      "auto-heal:raw/2026-05-21/codex-abc.md",
    ]);
  });
});
