import { describe, expect, it } from "vitest";
import { opencodeEventBody } from "../../src/hooks/opencode-event.js";

describe("opencodeEventBody", () => {
  it("writes a raw session event block for supported OpenCode events", async () => {
    const calls: Array<{
      tool: string;
      sessionId: string;
      cwd: string;
      block?: string;
    }> = [];

    await opencodeEventBody(
      {
        type: "tool.execute.after",
        sessionID: "sess-1",
        cwd: "C:/work/app",
        tool: "bash",
        input: { command: "npm test" },
        output: { exit: 0 },
      },
      {
        ensureRawSessionFile: async (input) => {
          calls.push(input);
          return "raw.md";
        },
        appendBlock: async (input) => {
          calls.push({
            tool: input.tool,
            sessionId: input.sessionId,
            cwd: "",
            block: input.block,
          });
        },
        now: () => new Date("2026-06-06T08:00:00.000Z"),
      },
    );

    expect(calls[0]).toMatchObject({
      tool: "opencode",
      sessionId: "sess-1",
      cwd: "C:/work/app",
    });
    expect(calls[1].block).toContain("## [08:00:00] OpenCode Event: tool.execute.after");
    expect(calls[1].block).toContain('"command": "npm test"');
  });

  it("redacts secrets before appending the OpenCode event payload", async () => {
    let block = "";

    await opencodeEventBody(
      {
        type: "session.created",
        sessionID: "sess-2",
        input: { command: "OPENAI_API_KEY=sk-live-secret-material-123456" },
      },
      {
        ensureRawSessionFile: async () => "raw.md",
        appendBlock: async (input) => {
          block = input.block;
        },
        now: () => new Date("2026-06-06T08:00:00.000Z"),
      },
    );

    expect(block).toContain("[REDACTED]");
    expect(block).not.toContain("sk-live-secret-material-123456");
  });

  it("ignores payloads without an event type", async () => {
    let appendCalls = 0;

    await opencodeEventBody(
      {},
      {
        appendBlock: async () => {
          appendCalls += 1;
        },
      },
    );

    expect(appendCalls).toBe(0);
  });
});
