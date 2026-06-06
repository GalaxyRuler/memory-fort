import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSyncPrompts } from "../../../src/cli/commands/sync-prompts.js";

describe("runSyncPrompts", () => {
  let tmp: string;
  let root: string;
  let sourceRepoDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sync-prompts-"));
    root = join(tmp, ".memory");
    sourceRepoDir = join(tmp, "source");
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(sourceRepoDir, "templates", "prompts"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans and applies bundled prompt copies while skipping customized vault prompts", async () => {
    await writeFile(join(sourceRepoDir, "templates", "prompts", "compile.md"), bundled("compile", "current compile"));
    await writeFile(join(sourceRepoDir, "templates", "prompts", "lint.md"), bundled("lint", "current lint"));
    await writeFile(join(root, "prompts", "compile.md"), "stale compile\n");
    await writeFile(join(root, "prompts", "lint.md"), "# memory:custom\ncustom lint\n");

    const plan = await runSyncPrompts({ vaultRoot: root, sourceRepoDir, apply: false });
    const applied = await runSyncPrompts({ vaultRoot: root, sourceRepoDir, apply: true });

    expect(plan.actions).toEqual([
      { name: "compile.md", action: "copy", path: "prompts/compile.md" },
      { name: "lint.md", action: "skip-custom", path: "prompts/lint.md" },
    ]);
    expect(applied.actions).toEqual(plan.actions);
    expect(await readFile(join(root, "prompts", "compile.md"), "utf-8")).toContain("current compile");
    expect(await readFile(join(root, "prompts", "lint.md"), "utf-8")).toContain("custom lint");
  });

  it("creates missing vault prompt files on apply", async () => {
    await writeFile(join(sourceRepoDir, "templates", "prompts", "hyde.md"), bundled("hyde", "current hyde"));

    const result = await runSyncPrompts({ vaultRoot: root, sourceRepoDir, apply: true });

    expect(result.actions).toEqual([
      { name: "hyde.md", action: "copy", path: "prompts/hyde.md" },
    ]);
    expect(existsSync(join(root, "prompts", "hyde.md"))).toBe(true);
  });
});

function bundled(name: string, body: string): string {
  return `<!-- memory:template ${name}:test -->\n${body}\n`;
}
