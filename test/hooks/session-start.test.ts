import { describe, it, expect } from "vitest";
import { sessionStartBody } from "../../src/hooks/session-start.js";

describe("sessionStartBody", () => {
  it("emits schema + index + log sections when all present", async () => {
    const writes: string[] = [];
    await sessionStartBody(
      {},
      {
        readFile: async (path) => {
          if (path.endsWith("schema.md")) return "schema content";
          if (path.endsWith("index.md")) return "index content";
          if (path.endsWith("log.md")) return "line1\nline2\nline3";
          throw new Error("ENOENT");
        },
        write: (t) => writes.push(t),
      },
    );
    const all = writes.join("");
    expect(all).toContain("schema content");
    expect(all).toContain("index content");
    expect(all).toContain("line1");
  });

  it("skips missing files silently", async () => {
    const writes: string[] = [];
    await sessionStartBody(
      {},
      {
        readFile: async () => {
          throw new Error("ENOENT");
        },
        write: (t) => writes.push(t),
      },
    );
    const all = writes.join("");
    expect(all).toContain("[memory:session-start]");
    expect(all).not.toContain("Schema");
  });

  it("tails log.md to last 20 lines", async () => {
    const writes: string[] = [];
    const longLog = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    await sessionStartBody(
      {},
      {
        readFile: async (path) => {
          if (path.endsWith("log.md")) return longLog;
          throw new Error("ENOENT");
        },
        write: (t) => writes.push(t),
      },
    );
    const all = writes.join("");
    expect(all).not.toContain("line0");
    expect(all).toContain("line49");
  });
});
