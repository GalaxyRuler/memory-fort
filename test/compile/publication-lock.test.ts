import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyCompileOperations, applyOperation } from "../../src/compile/execute.js";
import { compileExecuteLockTarget } from "../../src/compile/execute-lock.js";
import { rebuildIndex } from "../../src/compile/index.js";
import { withFileLock } from "../../src/storage/file-lock.js";

describe("canonical compile publication lock", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compile-publication-lock-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prevents direct applyOperation callers from bypassing the shared lock", async () => {
    const blocked = await whileCompileLockHeld(() => applyOperation(root, {
      kind: "write_page",
      path: "wiki/threads/direct-operation.md",
      frontmatter: { type: "threads", title: "Direct operation" },
      body: "Direct operation body.",
    }));

    expect(blocked.settledWhileHeld).toBe(false);
    await expect(blocked.result).resolves.toMatchObject({ ok: true, outcome: "created" });
    expect(existsSync(join(root, "wiki", "threads", "direct-operation.md"))).toBe(true);
  });

  it("prevents direct applyCompileOperations callers from bypassing the shared lock", async () => {
    for (const name of ["a", "b"]) {
      const rawPath = join(root, "raw", "2026-05-28", `${name}.md`);
      await mkdir(dirname(rawPath), { recursive: true });
      await writeFile(rawPath, `${name} source\n`, "utf-8");
    }
    const blocked = await whileCompileLockHeld(() => applyCompileOperations({
      vaultRoot: root,
      operations: [{
        kind: "write_page",
        path: "wiki/threads/direct-batch.md",
        frontmatter: {
          type: "threads",
          title: "Direct batch",
          relations: {
            derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"],
          },
        },
        body: "Direct batch body.",
      }],
    }));

    expect(blocked.settledWhileHeld).toBe(false);
    await expect(blocked.result).resolves.toMatchObject({
      applied: ["wiki/threads/direct-batch.md"],
    });
    expect(existsSync(join(root, "wiki", "threads", "direct-batch.md"))).toBe(true);
  });

  it("prevents direct rebuildIndex callers from bypassing the shared lock", async () => {
    const pagePath = join(root, "wiki", "projects", "indexed.md");
    await mkdir(dirname(pagePath), { recursive: true });
    await writeFile(pagePath, [
      "---",
      "type: projects",
      "title: Indexed",
      "---",
      "",
      "Indexed body.",
      "",
    ].join("\n"), "utf-8");

    const blocked = await whileCompileLockHeld(() => rebuildIndex(root));

    expect(blocked.settledWhileHeld).toBe(false);
    await expect(blocked.result).resolves.toMatchObject({ changed: true, entries: 1 });
    await expect(readFile(join(root, "index.md"), "utf-8"))
      .resolves.toContain("[Indexed](wiki/projects/indexed.md)");
  });

  async function whileCompileLockHeld<T>(operation: () => Promise<T>): Promise<{
    settledWhileHeld: boolean;
    result: Promise<T>;
  }> {
    let release!: () => void;
    let holderStarted!: () => void;
    const started = new Promise<void>((resolve) => { holderStarted = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const holder = withFileLock(compileExecuteLockTarget(root), async () => {
      holderStarted();
      await hold;
    });
    await started;

    let settled = false;
    const result = operation().finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settledWhileHeld = settled;
    release();
    await holder;
    return { settledWhileHeld, result };
  }
});
