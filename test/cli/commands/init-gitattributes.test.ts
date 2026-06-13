import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../../src/cli/commands/init.js";

describe("init .gitattributes", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "init-gitattributes-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("declares union merge for raw observation logs", async () => {
    await runInit({ vault: root, sourceRepoDir: process.cwd() });
    const content = await readFile(join(root, ".gitattributes"), "utf-8");
    expect(content).toContain("raw/**/*.md merge=union");
  });
});
