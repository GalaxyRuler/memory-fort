import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLog } from "../../../src/cli/commands/log.js";

describe("runLog", () => {
  let tmp: string;
  let origMem: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "log-"));
    origMem = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    await rm(tmp, { recursive: true, force: true });
  });

  it("appends a basic observation and returns path, session, and byte count", async () => {
    const result = await runLog({
      text: "Remember: Windows stale ports take ~5 min to release.",
      now: new Date(Date.UTC(2026, 4, 21, 12, 0, 0)),
    });
    expect(existsSync(result.path)).toBe(true);
    expect(result.sessionId).toMatch(/^manual-\d+$/);
    expect(result.bytesAppended).toBeGreaterThan(0);
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("source: manual");
    expect(content).toContain("Remember: Windows stale ports take ~5 min to release.");
    expect(content).toContain("## [12:00:00] Observation");
  });

  it("includes tags and confidence in the metadata line", async () => {
    const result = await runLog({
      text: "Test tagging.",
      tags: ["alpha", "beta"],
      confidence: 0.8,
      now: new Date(Date.UTC(2026, 4, 21, 12, 0, 0)),
    });
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("alpha");
    expect(content).toContain("beta");
    expect(content).toContain("0.8");
  });

  it("rejects empty text", async () => {
    await expect(runLog({ text: "   " })).rejects.toThrow(/non-empty/);
  });

  it("rejects out-of-range confidence", async () => {
    await expect(runLog({ text: "x", confidence: 1.5 })).rejects.toThrow(/0 and 1/);
    await expect(runLog({ text: "x", confidence: -0.1 })).rejects.toThrow(/0 and 1/);
  });

  it("accepts confidence=0 and confidence=1 boundaries", async () => {
    await expect(runLog({ text: "low", confidence: 0 })).resolves.toBeDefined();
    await expect(runLog({ text: "high", confidence: 1 })).resolves.toBeDefined();
  });

  it("appends to the same file when called twice with the same session id", async () => {
    const fixedNow = new Date(Date.UTC(2026, 4, 21, 12, 0, 0));
    const sessionFn = () => "manual-fixed-123";
    const first = await runLog({ text: "first", now: fixedNow, sessionId: sessionFn });
    const second = await runLog({ text: "second", now: fixedNow, sessionId: sessionFn });
    expect(first.path).toBe(second.path);
    const content = await readFile(first.path, "utf-8");
    expect(content).toContain("first");
    expect(content).toContain("second");
  });
});
