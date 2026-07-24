import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runForget } from "../../src/cli/commands/forget.js";
import { compileExecuteLockTarget } from "../../src/compile/execute-lock.js";
import { readIndexGeneration } from "../../src/index/generation.js";
import { serializeFrontmatter } from "../../src/storage/frontmatter.js";

describe("dashboard promotion and forget publication fence", () => {
  let tmp: string;
  let root: string;
  let previousRoot: string | undefined;
  let previousIndexPath: string | undefined;
  let previousSpoolDir: string | undefined;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "dashboard-promote-forget-"));
    root = join(tmp, ".memory");
    previousRoot = process.env["MEMORY_ROOT"];
    previousIndexPath = process.env["MEMORY_INDEX_DB_PATH"];
    previousSpoolDir = process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    process.env["MEMORY_ROOT"] = root;
    process.env["MEMORY_INDEX_DB_PATH"] = join(tmp, "index.db");
    process.env["MEMORY_CAPTURE_SPOOL_DIR"] = join(tmp, "capture-spool");
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    if (previousRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = previousRoot;
    if (previousIndexPath === undefined) delete process.env["MEMORY_INDEX_DB_PATH"];
    else process.env["MEMORY_INDEX_DB_PATH"] = previousIndexPath;
    if (previousSpoolDir === undefined) delete process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    else process.env["MEMORY_CAPTURE_SPOOL_DIR"] = previousSpoolDir;
    await rm(tmp, { recursive: true, force: true });
  });

  it.each(["compile", "thread", "procedure"] as const)(
    "serializes a real child %s promotion snapshot before forget replans",
    async (kind) => {
    const raw = `raw/2026-05-20/codex-${kind}-promoted-then-forgotten.md`;
    const derivative = kind === "compile"
      ? "wiki/projects/promoted-then-forgotten.md"
      : `wiki/${kind === "thread" ? "threads" : "procedures"}/promoted-then-forgotten.md`;
    await writeAt(raw, "source that must be forgotten\n");
    if (kind === "compile") {
      await writeAt("wiki/compile-proposed/promoted-then-forgotten.md", compileProposal({
        kind: "write_page",
        path: derivative,
        frontmatter: generatedFrontmatter("projects", raw),
        body: "FORGOTTEN-PROMOTION-DERIVATIVE",
      }));
    } else {
      const proposedDir = kind === "thread" ? "threads-proposed" : "procedures-proposed";
      await writeAt(`wiki/${proposedDir}/promoted-then-forgotten.md`, serializeFrontmatter(
        generatedFrontmatter(kind === "thread" ? "threads" : "procedures", raw),
        "FORGOTTEN-PROMOTION-DERIVATIVE\n",
      ));
    }

    const readyPath = join(tmp, "promotion.ready");
    const releasePath = join(tmp, "promotion.release");
    const child = spawnPromotionChild(kind, readyPath, releasePath);
    children.push(child);
    const childExit = waitForChildExit(child);
    await waitForPath(readyPath, 5_000);
    const compileLockPath = `${compileExecuteLockTarget(root)}.lock`;
    const compileOwnerPid = existsSync(compileLockPath)
      ? (JSON.parse(await readFile(compileLockPath, "utf-8")) as { pid?: unknown }).pid
      : null;

    let forgetSettled = false;
    const forgetting = runForget({ mode: "apply", rawPaths: [raw] })
      .finally(() => { forgetSettled = true; });
    const forgetApplyLockPath = join(root, "var", "forget-apply.lock");
    await waitForCondition(
      () => forgetSettled || existsSync(forgetApplyLockPath),
      5_000,
      "forget to settle or enter its outer lock",
    );
    const forgetWaitingWhilePromotionPaused = !forgetSettled && existsSync(forgetApplyLockPath);
    const rawPresentWhilePromotionPaused = existsSync(join(root, ...raw.split("/")));

    await writeFile(releasePath, "release\n", "utf-8");
    await expect(childExit).resolves.toMatchObject({ code: 0 });
    await expect(forgetting).resolves.toMatchObject({
      status: "live-erased/history-retained",
      erased: expect.arrayContaining([raw, derivative]),
    });

    expect(compileOwnerPid).toBe(child.pid);
    expect(forgetWaitingWhilePromotionPaused).toBe(true);
    expect(rawPresentWhilePromotionPaused).toBe(true);
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    expect(existsSync(join(root, ...derivative.split("/")))).toBe(false);
    expect(readIndexGeneration(root).state).toBe("ready");
    await expect(readFile(join(root, "index.md"), "utf-8"))
      .resolves.not.toContain("FORGOTTEN-PROMOTION-DERIVATIVE");
  }, 15_000);

  function spawnPromotionChild(
    kind: "compile" | "thread" | "procedure",
    readyPath: string,
    releasePath: string,
  ): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, [
      join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"),
      join(process.cwd(), "test", "fixtures", "dashboard-promote-child.ts"),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEMORY_TEST_ROOT: root,
        MEMORY_TEST_PROMOTION_READY: readyPath,
        MEMORY_TEST_PROMOTION_RELEASE: releasePath,
        MEMORY_TEST_PROMOTION_SLUG: "promoted-then-forgotten",
        MEMORY_TEST_PROMOTION_KIND: kind,
      },
      windowsHide: true,
    });
  }

  async function writeAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(root, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function waitForPath(path: string, timeoutMs: number): Promise<void> {
  return waitForCondition(() => existsSync(path), timeoutMs, path);
}

function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${description}`));
        return;
      }
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

function compileProposal(operation: Record<string, unknown>): string {
  return [
    "---",
    "type: references",
    "title: compile proposal",
    "status: active",
    "lifecycle: proposed",
    "---",
    "",
    `# Compile proposal: ${operation["path"]}`,
    "",
    "```compile-op",
    JSON.stringify(operation, null, 2),
    "```",
    "",
  ].join("\n");
}

function generatedFrontmatter(type: string, raw: string): Record<string, unknown> {
  return {
    type,
    title: "Promoted then forgotten",
    generated: true,
    generated_by: "memory-fort",
    source_facts: [raw],
    relations: { derived_from: [raw] },
  };
}
