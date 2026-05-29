import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";

describe("runInit - prompts/ population", () => {
  let tmp: string;
  let origMem: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "initpr-"));
    origMem = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = join(tmp, ".memory");
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates ~/.memory/prompts/ subdirectory", async () => {
    const result = await runInit({ sourceRepoDir: process.cwd() });
    expect(existsSync(join(result.root, "prompts"))).toBe(true);
  }, 60_000);

  it("copies compile.md and lint.md from templates/prompts/", async () => {
    const result = await runInit({ sourceRepoDir: process.cwd() });
    expect(existsSync(join(result.root, "prompts", "compile.md"))).toBe(true);
    expect(existsSync(join(result.root, "prompts", "lint.md"))).toBe(true);
  }, 60_000);

  it("copied prompt content matches the source verbatim", async () => {
    const result = await runInit({ sourceRepoDir: process.cwd() });
    const src = await readFile(
      join(process.cwd(), "templates", "prompts", "compile.md"),
      "utf-8",
    );
    const dest = await readFile(
      join(result.root, "prompts", "compile.md"),
      "utf-8",
    );
    expect(dest).toBe(src);
  }, 60_000);

  it(
    "preserves existing user-edited prompt files on re-init",
    async () => {
      await runInit({ sourceRepoDir: process.cwd() });
      const userEdited = "# My custom compile prompt\n\nUser content here.\n";
      await writeFile(
        join(process.env["MEMORY_ROOT"]!, "prompts", "compile.md"),
        userEdited,
      );

      const result = await runInit({ sourceRepoDir: process.cwd() });
      const after = await readFile(
        join(result.root, "prompts", "compile.md"),
        "utf-8",
      );
      expect(after).toBe(userEdited);
      expect(result.preserved.some((p) => p.endsWith("compile.md"))).toBe(true);
    },
    60_000,
  );

  it("silently skips when source prompt file missing (tolerant)", async () => {
    const fakeSrc = join(tmp, "fake-repo");
    await mkdir(join(fakeSrc, "templates"), { recursive: true });
    await writeFile(
      join(fakeSrc, "templates", "schema.md"),
      "---\nschema_version: 1\n---\n# Schema\n",
    );

    const result = await runInit({ sourceRepoDir: fakeSrc });
    expect(existsSync(join(result.root, "prompts"))).toBe(true);
    expect(existsSync(join(result.root, "prompts", "compile.md"))).toBe(false);
  }, 60_000);
});
