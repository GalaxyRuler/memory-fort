import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confidenceAwareIndex } from "../../src/hooks/session-start-helpers.js";
import { sessionStartBody } from "../../src/hooks/session-start.js";

describe("sessionStartBody", () => {
  let tmp: string;
  let oldMemoryRoot: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "session-start-"));
    oldMemoryRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
  });

  afterEach(async () => {
    if (oldMemoryRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = oldMemoryRoot;
    await rm(tmp, { recursive: true, force: true });
  });

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

  it("injects preferences page, preference-tagged observations, and recent high-confidence observations", async () => {
    await mkdir(join(tmp, "wiki"), { recursive: true });
    await mkdir(join(tmp, "raw", "2026-05-28"), { recursive: true });
    await writeFile(join(tmp, "schema.md"), "schema content");
    await writeFile(join(tmp, "index.md"), "# Index\n\nNo curated pages yet.\n");
    await writeFile(join(tmp, "log.md"), "line1\nline2");
    await writeFile(
      join(tmp, "wiki", "preferences.md"),
      [
        "---",
        "type: references",
        "title: Operator Preferences",
        "tags: [preference]",
        "confidence: 0.95",
        "---",
        "Always draft Codex prompts before handing them off.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(tmp, "raw", "2026-05-28", "manual-session.md"),
      [
        "---",
        "type: raw-session",
        "title: manual session",
        "created: 2026-05-28",
        "updated: 2026-05-28",
        "---",
        "",
        "## [08:00:00] Observation",
        "",
        "_tags: preference, codex · confidence: 0.91_",
        "",
        "Emit paths in code blocks when preparing handoff prompts.",
        "",
        "## [09:00:00] Observation",
        "",
        "_tags: project · confidence: 0.88_",
        "",
        "Memory Fort should feed recent salient observations back at session start.",
        "",
        "## [10:00:00] Observation",
        "",
        "_tags: noise · confidence: 0.2_",
        "",
        "Low confidence noise should stay out of the injected reminder block.",
        "",
      ].join("\n"),
    );

    const writes: string[] = [];
    await sessionStartBody({}, { write: (text) => writes.push(text) });

    const all = writes.join("");
    expect(all).toContain("--- What you should remember");
    expect(all).toContain("Always draft Codex prompts");
    expect(all).toContain("Emit paths in code blocks");
    expect(all).toContain("Memory Fort should feed recent salient observations");
    expect(all).not.toContain("Low confidence noise");
  });

  it("omits the reminder block when there are no preferences or recent salient observations", async () => {
    await writeFile(join(tmp, "schema.md"), "schema content");
    await writeFile(join(tmp, "index.md"), "# Index\n");
    await writeFile(join(tmp, "log.md"), "line1\n");

    const writes: string[] = [];
    await sessionStartBody({}, { write: (text) => writes.push(text) });

    expect(writes.join("")).not.toContain("What you should remember");
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
