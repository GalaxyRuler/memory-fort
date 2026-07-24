import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runForget } from "../../src/cli/commands/forget.js";
import { compileExecuteLockTarget } from "../../src/compile/execute-lock.js";
import { parseFrontmatter, serializeFrontmatter } from "../../src/storage/frontmatter.js";

describe("supersede approval and forget publication fence", () => {
  let tmp: string;
  let root: string;
  let previousRoot: string | undefined;
  let previousIndexPath: string | undefined;
  let previousSpoolDir: string | undefined;
  let child: ChildProcessWithoutNullStreams | null;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "approve-supersede-forget-"));
    root = join(tmp, ".memory");
    previousRoot = process.env["MEMORY_ROOT"];
    previousIndexPath = process.env["MEMORY_INDEX_DB_PATH"];
    previousSpoolDir = process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    process.env["MEMORY_ROOT"] = root;
    process.env["MEMORY_INDEX_DB_PATH"] = join(tmp, "index.db");
    process.env["MEMORY_CAPTURE_SPOOL_DIR"] = join(tmp, "capture-spool");
    await mkdir(root, { recursive: true });
    child = null;
  });

  afterEach(async () => {
    if (child?.exitCode === null) child.kill();
    if (previousRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = previousRoot;
    if (previousIndexPath === undefined) delete process.env["MEMORY_INDEX_DB_PATH"];
    else process.env["MEMORY_INDEX_DB_PATH"] = previousIndexPath;
    if (previousSpoolDir === undefined) delete process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    else process.env["MEMORY_CAPTURE_SPOOL_DIR"] = previousSpoolDir;
    await rm(tmp, { recursive: true, force: true });
  });

  it("holds approval from its canonical snapshot until forget can freshly remove the derivative", async () => {
    const raw = "raw/2026-05-20/codex-superseded-then-forgotten.md";
    const oldPage = "wiki/tools/old-generated-tool.md";
    const newPage = "wiki/tools/replacement-tool.md";
    const proposal = "wiki/compile-proposed/supersede-old-generated-tool.md";
    await writeAt(raw, "source that must be forgotten\n");
    await writeAt(oldPage, serializeFrontmatter({
      type: "tools",
      title: "Old generated tool",
      generated: true,
      generated_by: "memory-fort",
      source_facts: [raw],
      relations: { derived_from: [raw] },
      status: "active",
    }, "OLD-GENERATED-DERIVATIVE\n"));
    await writeAt(newPage, serializeFrontmatter({
      type: "tools",
      title: "Replacement tool",
      status: "active",
    }, "Replacement survives.\n"));
    const proposalPath = join(root, ...proposal.split("/"));
    await writeAt(proposal, serializeFrontmatter({
      type: "references",
      title: "Supersede old generated tool",
      old_page: oldPage,
      new_page: newPage,
      old_page_patch: { valid_until: "2026-05-20", status: "superseded" },
      proposal_status: "pending-review",
    }, "Supersede old generated tool.\n"));

    const readyPath = join(tmp, "approval.ready");
    const releasePath = join(tmp, "approval.release");
    child = spawn(process.execPath, [
      join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"),
      join(process.cwd(), "test", "fixtures", "approve-supersede-child.ts"),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEMORY_TEST_ROOT: root,
        MEMORY_TEST_APPROVAL_PROPOSAL: proposalPath,
        MEMORY_TEST_APPROVAL_READY: readyPath,
        MEMORY_TEST_APPROVAL_RELEASE: releasePath,
      },
      windowsHide: true,
    });
    const childExit = waitForChildExit(child);
    await waitForPath(readyPath, 5_000);
    const compileLockPath = `${compileExecuteLockTarget(root)}.lock`;
    const lockOwnerPid = await readUniqueClaimOwnerPid(compileLockPath);

    let forgetSettled = false;
    const forgetting = runForget({ mode: "apply", rawPaths: [raw] })
      .finally(() => { forgetSettled = true; });
    const forgetApplyLockPath = join(root, "var", "forget-apply.lock");
    await waitForCondition(
      () => forgetSettled || existsSync(forgetApplyLockPath),
      5_000,
      "forget to settle or enter its outer lock",
    );
    expect(forgetSettled).toBe(false);
    expect(existsSync(join(root, ...raw.split("/")))).toBe(true);

    await writeFile(releasePath, "release\n", "utf-8");
    await expect(childExit).resolves.toMatchObject({ code: 0 });
    await expect(forgetting).resolves.toMatchObject({
      status: "live-erased/history-retained",
      erased: expect.arrayContaining([raw, oldPage]),
    });

    expect(lockOwnerPid).toBe(child.pid);
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    expect(existsSync(join(root, ...oldPage.split("/")))).toBe(false);
    expect(existsSync(join(root, ...newPage.split("/")))).toBe(true);
    const approved = parseFrontmatter(await readFile(proposalPath, "utf-8"));
    expect(approved.frontmatter.proposal_status).toBe("approved");
  }, 15_000);

  async function writeAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(root, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function waitForPath(path: string, timeoutMs: number): Promise<void> {
  return waitForCondition(() => existsSync(path), timeoutMs, path);
}

async function readUniqueClaimOwnerPid(lockDirectory: string): Promise<unknown> {
  for (const name of (await readdir(lockDirectory)).filter((entry) => entry.endsWith(".json")).sort()) {
    const claim = JSON.parse(await readFile(join(lockDirectory, name), "utf-8")) as { pid?: unknown };
    if (claim.pid !== undefined) return claim.pid;
  }
  return null;
}

function waitForCondition(condition: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (condition()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${description}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
