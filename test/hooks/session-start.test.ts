import { afterEach, describe, it, expect } from "vitest";
import { join } from "node:path";
import { confidenceAwareIndex } from "../../src/hooks/session-start-helpers.js";
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
    expect(all).toContain("--- Medium-confidence entries (1) ---");
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

  it("emits confidence-bucketed index output", async () => {
    const writes: string[] = [];
    await sessionStartBody(
      {},
      {
        readFile: makeConfidenceReadFile(),
        write: (t) => writes.push(t),
      },
    );

    const all = writes.join("");
    expect(all).toContain("--- High-confidence entries (1) ---");
    expect(all).toContain("- [[projects/high]] High");
    expect(all).toContain("--- Medium-confidence entries (1) ---");
    expect(all).toContain("- [[projects/medium]] Medium");
    expect(all).toContain("--- Low-confidence / drafts (1) ---");
    expect(all).toContain("⚠ DRAFT: - [[projects/low]] Low");
  });
});

describe("confidenceAwareIndex", () => {
  const oldFloor = process.env["MEMORY_FORT_INJECTION_CONF_FLOOR"];

  afterEach(() => {
    if (oldFloor === undefined) delete process.env["MEMORY_FORT_INJECTION_CONF_FLOOR"];
    else process.env["MEMORY_FORT_INJECTION_CONF_FLOOR"] = oldFloor;
  });

  it("groups index entries into high, medium, and draft buckets", async () => {
    const output = await confidenceAwareIndex({
      indexFilePath: join("C:/mem", "index.md"),
      memoryRoot: "C:/mem",
      readFile: makeConfidenceReadFile(),
    });

    expect(output).toContain("--- High-confidence entries (1) ---");
    expect(output).toContain("- [[projects/high]] High");
    expect(output).toContain("--- Medium-confidence entries (1) ---");
    expect(output).toContain("- [[projects/medium]] Medium");
    expect(output).toContain("--- Low-confidence / drafts (1) ---");
    expect(output).toContain("⚠ DRAFT: - [[projects/low]] Low");
  });

  it("suppresses entries below MEMORY_FORT_INJECTION_CONF_FLOOR", async () => {
    process.env["MEMORY_FORT_INJECTION_CONF_FLOOR"] = "0.5";

    const output = await confidenceAwareIndex({
      indexFilePath: join("C:/mem", "index.md"),
      memoryRoot: "C:/mem",
      readFile: makeConfidenceReadFile(),
    });

    expect(output).toContain("--- High-confidence entries (1) ---");
    expect(output).toContain("--- Medium-confidence entries (1) ---");
    expect(output).not.toContain("--- Low-confidence / drafts");
    expect(output).not.toContain("projects/low");
  });
});

function makeConfidenceReadFile(): (path: string) => Promise<string> {
  return async (path) => {
    const normalized = path.replace(/\\/g, "/");
    if (normalized.endsWith("/schema.md")) return "schema content";
    if (normalized.endsWith("/log.md")) return "line1\nline2\nline3";
    if (normalized.endsWith("/index.md")) {
      return [
        "- [[projects/high]] High",
        "- [[projects/medium]] Medium",
        "- [[projects/low]] Low",
      ].join("\n");
    }
    if (normalized.endsWith("/wiki/projects/high.md")) {
      return "---\ntitle: High\nconfidence: 0.9\n---\nHigh body.\n";
    }
    if (normalized.endsWith("/wiki/projects/medium.md")) {
      return "---\ntitle: Medium\nconfidence: 0.7\n---\nMedium body.\n";
    }
    if (normalized.endsWith("/wiki/projects/low.md")) {
      return "---\ntitle: Low\nconfidence: 0.3\n---\nLow body.\n";
    }
    throw new Error(`ENOENT: ${path}`);
  };
}
