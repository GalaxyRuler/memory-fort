import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/cli/commands/init.js";
import {
  applyAgentMemoryImportPlan,
  planAgentMemoryImport,
} from "../../src/migration/map-agentmemory.js";
import type { AgentMemoryKvEntry } from "../../src/migration/agentmemory-kv-reader.js";

describe("map agentmemory entries", () => {
  let tmp: string;
  let memDir: string;
  let origMem: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "agentmemory-map-"));
    memDir = join(tmp, ".memory");
    origMem = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = memDir;
    await runInit({ sourceRepoDir: process.cwd() });
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    await rm(tmp, { recursive: true, force: true });
  });

  it("maps observations to raw session pages with preserved metadata", async () => {
    const plan = await planAgentMemoryImport({
      entries: [
        entry("mem:obs:session-1", "obs_1", {
          id: "obs_1",
          title: "Ran installer",
          timestamp: "2026-05-25T12:34:56.000Z",
          confidence: 0.7,
          concepts: ["install"],
          narrative: "Installed a client.",
          files: ["src/cli.ts"],
        }),
      ],
      root: memDir,
    });

    expect(plan.actions[0]!.action).toBe("write");
    expect(plan.actions[0]!.relPath).toBe("raw/2026-05-25/agentmemory-obs_1.md");
    expect(plan.actions[0]!.content).toContain("imported_from:");
    expect(plan.actions[0]!.content).toContain("original_key: mem:obs:session-1:obs_1");
    expect(plan.counts.raw).toBe(1);
  });

  it("maps memories and insights to curated wiki pages", async () => {
    const plan = await planAgentMemoryImport({
      entries: [
        entry("mem:memories", "mem_1", {
          id: "mem_1",
          type: "decision",
          title: "Use Memory Fort",
          content: "Memory Fort is canonical.",
          createdAt: "2026-05-20T10:00:00.000Z",
          updatedAt: "2026-05-21T10:00:00.000Z",
          tags: ["migration"],
        }),
        entry("mem:insights", "ins_1", {
          id: "ins_1",
          title: "Migration pressure",
          insight: "Historical observations need a canonical vault.",
          createdAt: "2026-05-22T10:00:00.000Z",
        }),
      ],
      root: memDir,
    });

    expect(plan.actions.map((action) => action.relPath)).toEqual([
      "wiki/decisions/use-memory-fort.md",
      "wiki/crystals/migration-pressure.md",
    ]);
  });

  it("dedupes by title and writes imported suffix for newer incoming content", async () => {
    await mkdir(join(memDir, "wiki", "decisions"), { recursive: true });
    await writeFile(
      join(memDir, "wiki", "decisions", "use-memory-fort.md"),
      "---\ntype: decisions\ntitle: Use Memory Fort\ncreated: \"2026-05-01\"\nupdated: \"2026-05-01\"\n---\n\nOld body.\n",
    );

    const plan = await planAgentMemoryImport({
      entries: [
        entry("mem:memories", "mem_1", {
          id: "mem_1",
          type: "decision",
          title: "Use Memory Fort",
          content: "Newer body.",
          updatedAt: "2026-05-25T10:00:00.000Z",
        }),
      ],
      root: memDir,
    });

    expect(plan.actions[0]!.action).toBe("conflict");
    expect(plan.actions[0]!.relPath).toBe("wiki/decisions/use-memory-fort.imported.md");
  });

  it("dedupes an existing imported conflict by content hash before title", async () => {
    await mkdir(join(memDir, "wiki", "decisions"), { recursive: true });
    await writeFile(
      join(memDir, "wiki", "decisions", "use-memory-fort.md"),
      "---\ntype: decisions\ntitle: Use Memory Fort\ncreated: \"2026-05-01\"\nupdated: \"2026-05-01\"\n---\n\nOld body.\n",
    );

    const first = await planAgentMemoryImport({
      entries: [
        entry("mem:memories", "mem_1", {
          id: "mem_1",
          type: "decision",
          title: "Use Memory Fort",
          content: "Newer body.",
          updatedAt: "2026-05-25T10:00:00.000Z",
        }),
      ],
      root: memDir,
    });
    await applyAgentMemoryImportPlan(first, { root: memDir });

    const second = await planAgentMemoryImport({
      entries: [
        entry("mem:memories", "mem_1", {
          id: "mem_1",
          type: "decision",
          title: "Use Memory Fort",
          content: "Newer body.",
          updatedAt: "2026-05-25T10:00:00.000Z",
        }),
      ],
      root: memDir,
    });

    expect(second.actions[0]!.action).toBe("dedup-skipped");
    expect(second.actions[0]!.relPath).toBe("wiki/decisions/use-memory-fort.imported.md");
  });

  it("apply writes pages and an audit log", async () => {
    const plan = await planAgentMemoryImport({
      entries: [
        entry("mem:memories", "mem_1", {
          id: "mem_1",
          type: "reference",
          title: "Legacy format",
          content: "Files contain JSON plus trailing bytes.",
        }),
      ],
      root: memDir,
    });

    const result = await applyAgentMemoryImportPlan(plan, {
      root: memDir,
      now: new Date("2026-05-26T00:00:00.000Z"),
    });

    expect(result.written).toHaveLength(1);
    expect(await readFile(join(memDir, "wiki", "references", "legacy-format.md"), "utf-8"))
      .toContain("Files contain JSON");
    expect(result.auditLogPath).toContain("wiki\\.audit");
  });

  it("preserves unknown auxiliary stores as legacy reference pages", async () => {
    const plan = await planAgentMemoryImport({
      entries: [
        entry("mem:access", "obs_1", {
          id: "obs_1",
          lastAccessed: "2026-05-25T00:00:00.000Z",
          count: 3,
        }),
      ],
      root: memDir,
    });

    expect(plan.actions[0]!.action).toBe("write");
    expect(plan.actions[0]!.relPath).toBe("wiki/references/agentmemory-mem-access-obs-1.md");
    expect(plan.actions[0]!.content).toContain('"lastAccessed": "2026-05-25T00:00:00.000Z"');
  });
});

function entry(scope: string, entryKey: string, value: unknown): AgentMemoryKvEntry {
  return {
    scope,
    entryKey,
    key: `${scope}:${entryKey}`,
    value,
    filePath: "fixture.bin",
  };
}
