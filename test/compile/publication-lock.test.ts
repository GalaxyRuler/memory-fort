import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDiscoverThreads } from "../../src/cli/commands/discover-threads.js";
import { runProcedurePromote, runProcedurePropose } from "../../src/cli/commands/procedure.js";
import { runThreadPromote, runThreadPropose } from "../../src/cli/commands/thread.js";
import { applyApprovedSupersedeProposal } from "../../src/compile/approve-supersede.js";
import { applyCompileOperations, applyOperation } from "../../src/compile/execute.js";
import { compileExecuteLockTarget } from "../../src/compile/execute-lock.js";
import { rebuildIndex } from "../../src/compile/index.js";
import { serializeFrontmatter } from "../../src/storage/frontmatter.js";
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

  it("prevents supersede approval from snapshotting outside the shared lock", async () => {
    await writeAt("wiki/tools/old.md", page("tools", "Old", "Old body."));
    await writeAt("wiki/tools/new.md", page("tools", "New", "New body."));
    const proposalPath = join(root, "wiki", "compile-proposed", "supersede-old.md");
    await writeAt("wiki/compile-proposed/supersede-old.md", serializeFrontmatter({
      type: "references",
      title: "Supersede old",
      old_page: "wiki/tools/old.md",
      new_page: "wiki/tools/new.md",
      old_page_patch: { valid_until: "2026-06-10", status: "superseded" },
      proposal_status: "pending-review",
    }, "Supersede old with new.\n"));

    const blocked = await whileCompileLockHeld(() => applyApprovedSupersedeProposal({
      vaultRoot: root,
      proposalPath,
      now: new Date("2026-06-10T08:00:00.000Z"),
    }));

    expect(blocked.settledWhileHeld).toBe(false);
    await expect(blocked.result).resolves.toEqual({ ok: true });
  });

  it.each([
    {
      kind: "thread",
      proposed: "wiki/threads-proposed/publication-lock.md",
      canonical: "wiki/threads/publication-lock.md",
      run: () => runThreadPromote({ vaultRoot: root, slug: "publication-lock" }),
    },
    {
      kind: "procedure",
      proposed: "wiki/procedures-proposed/publication-lock.md",
      canonical: "wiki/procedures/publication-lock.md",
      run: () => runProcedurePromote({ vaultRoot: root, slug: "publication-lock" }),
    },
  ])("prevents direct $kind promotion callers from bypassing the shared lock", async ({ proposed, canonical, run }) => {
    await writeAt(proposed, page("references", "Publication lock", "Generated draft."));

    const blocked = await whileCompileLockHeld(run);

    expect(blocked.settledWhileHeld).toBe(false);
    await expect(blocked.result).resolves.toMatchObject({ from: proposed, to: canonical });
    expect(existsSync(join(root, ...canonical.split("/")))).toBe(true);
  });

  it.each([
    {
      kind: "thread",
      run: () => runThreadPropose({
        vaultRoot: root,
        env: { MEMORY_LLM_DISABLED: "true" },
      }),
    },
    {
      kind: "procedure",
      run: () => runProcedurePropose({
        vaultRoot: root,
        env: { MEMORY_LLM_DISABLED: "true" },
      }),
    },
  ])("prevents direct $kind proposal callers from snapshotting outside the shared lock", async ({ run }) => {
    const blocked = await whileCompileLockHeld(run);

    expect(blocked.settledWhileHeld).toBe(false);
    await expect(blocked.result).rejects.toThrow("LLM access disabled");
  });

  it("prevents discover-threads proposal callers from snapshotting outside the shared lock", async () => {
    const blocked = await whileCompileLockHeld(() => runDiscoverThreads({
      vaultRoot: root,
      mode: "plan",
    }));

    expect(blocked.settledWhileHeld).toBe(false);
    await expect(blocked.result).resolves.toMatchObject({ mode: "plan" });
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
    const result = operation();
    void result.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settledWhileHeld = settled;
    release();
    await holder;
    return { settledWhileHeld, result };
  }

  async function writeAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(root, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function page(type: string, title: string, body: string): string {
  return serializeFrontmatter({ type, title, status: "active" }, `${body}\n`);
}
