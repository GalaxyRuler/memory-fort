import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runInit } from "../../../src/cli/commands/init.js";
import { runImportAgentMemory } from "../../../src/cli/commands/import-agentmemory.js";
import type { ConsolidateResult } from "../../../src/consolidate/runner.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";

describe("runImportAgentMemory", () => {
  let tmp: string;
  let memDir: string;
  let dataDir: string;
  let origMem: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "import-agentmemory-"));
    memDir = join(tmp, ".memory");
    dataDir = join(tmp, "agentmemory", "data");
    origMem = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = memDir;
    await runInit({ sourceRepoDir: process.cwd() });
    await mkdir(join(dataDir, "state_store.db"), { recursive: true });
    await writeFile(
      join(dataDir, "state_store.db", "mem%3Amemories.bin"),
      Buffer.from(JSON.stringify({
        mem_1: {
          id: "mem_1",
          type: "lesson",
          title: "Import carefully",
          content: "Dry run before writing.",
        },
      })),
    );
    await mkdir(join(dataDir, "stream_store"), { recursive: true });
    await writeFile(
      join(dataDir, "stream_store", "stream%3Amem-live%3A019e45fc-5e01-7180-9f0c-114a3b1f941a.bin"),
      Buffer.from(JSON.stringify({
        obs_2: {
          observation: {
            id: "obs_2",
            title: "Stream observation",
            timestamp: "2026-05-25T00:00:00.000Z",
            narrative: "Captured from the append-only stream.",
          },
        },
      })),
    );
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans without writing files", async () => {
    const result = await runImportAgentMemory({ from: dataDir, mode: "plan" });
    expect(result.report).toContain("Memory import-agentmemory plan");
    expect(result.report).toContain("write: 2");
    expect(existsSync(join(memDir, "wiki", "lessons", "import-carefully.md"))).toBe(false);
  });

  it("applies import and is idempotent on second run", async () => {
    const first = await runImportAgentMemory({
      from: dataDir,
      mode: "apply",
      now: new Date("2026-05-26T00:00:00.000Z"),
    });
    expect(first.report).toContain("audit:");
    expect(existsSync(join(memDir, "wiki", "lessons", "import-carefully.md"))).toBe(true);
    const imported = await readFile(join(memDir, "raw", "2026-05-25", "agentmemory-obs_2.md"), "utf-8");
    expect(parseFrontmatter(imported).frontmatter.observed_at).toBe("2026-05-20");

    const second = await runImportAgentMemory({
      from: dataDir,
      mode: "apply",
      now: new Date("2026-05-26T00:00:00.000Z"),
    });
    expect(second.report).toContain("dedup-skipped: 2");
  });

  it("can chain consolidation after an apply import", async () => {
    let consolidateCalls = 0;
    const result = await runImportAgentMemory({
      from: dataDir,
      mode: "apply",
      now: new Date("2026-05-26T00:00:00.000Z"),
      consolidateAfter: true,
      consolidateFn: async (opts) => {
        consolidateCalls += 1;
        expect(opts.plan).toBe(false);
        return consolidateResult();
      },
    });

    expect(consolidateCalls).toBe(1);
    expect(result.report).toContain("Memory consolidate apply");
  });

  function consolidateResult(): ConsolidateResult {
    return {
      mode: "apply",
      plans: [],
      summary: {
        scanned: 1,
        proposed: 1,
        proposedEdges: 1,
        updated: 1,
        newEdges: 1,
      },
      auditLogPath: join(memDir, "wiki", ".audit", "consolidate-2026-05-26T00-00-00-000Z.md"),
    };
  }
});
