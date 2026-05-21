import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStats, formatStatsResult } from "../../../src/cli/commands/stats.js";

describe("runStats", () => {
  let tmp: string;
  let origMem: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "stats-"));
    origMem = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns zero counts for an empty memory root", async () => {
    const result = await runStats();
    expect(result.raw.files).toBe(0);
    expect(result.wiki.files).toBe(0);
    expect(result.crystals.files).toBe(0);
  });

  it("counts raw markdown files recursively", async () => {
    await mkdir(join(tmp, "raw", "2026-05-21"), { recursive: true });
    await writeFile(join(tmp, "raw", "2026-05-21", "a.md"), "x");
    await writeFile(join(tmp, "raw", "2026-05-21", "b.md"), "y");
    const result = await runStats();
    expect(result.raw.files).toBe(2);
    expect(result.raw.bytes).toBe(2);
  });

  it("counts wiki markdown files across subdirs", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "wiki", "lessons"), { recursive: true });
    await writeFile(join(tmp, "wiki", "projects", "a.md"), "x");
    await writeFile(join(tmp, "wiki", "lessons", "b.md"), "yy");
    const result = await runStats();
    expect(result.wiki.files).toBe(2);
    expect(result.wiki.bytes).toBe(3);
  });

  it("reports installs as false when nothing is installed", async () => {
    const result = await runStats();
    expect(result.installs.claudeCode).toBe(false);
  });

  it("reports claude-code install when plugin .mcp.json exists", async () => {
    await mkdir(join(tmp, "claude-code-plugin"), { recursive: true });
    await writeFile(join(tmp, "claude-code-plugin", ".mcp.json"), '{"mcpServers":{}}');
    const result = await runStats();
    expect(result.installs.claudeCode).toBe(true);
  });

  it("reports errors.log byte size", async () => {
    await writeFile(join(tmp, "errors.log"), "boom\n");
    const result = await runStats();
    expect(result.errorsLogBytes).toBe(5);
  });

  it("counts embedding JSONL records", async () => {
    await mkdir(join(tmp, "embeddings"), { recursive: true });
    await writeFile(join(tmp, "embeddings", "raw.2026-05-21.jsonl"), "{}\n{}\n");
    const result = await runStats();
    expect(result.embeddings.records).toBe(2);
    expect(result.embeddings.bytes).toBe(6);
  });

  it("formatStatsResult includes the root path and counts", async () => {
    const result = await runStats();
    const out = formatStatsResult(result);
    expect(out).toContain(tmp);
    expect(out).toContain("raw/");
    expect(out).toContain("wiki/");
    expect(out).toContain("Git:");
  });
});
