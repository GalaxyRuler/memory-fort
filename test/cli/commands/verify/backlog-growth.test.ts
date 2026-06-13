import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBacklogGrowth } from "../../../../src/cli/commands/verify/backlog-growth.js";
import {
  readCompileStateFile,
  writeCompileStateFile,
} from "../../../../src/compile/state.js";

describe("compile.backlog-growth verify check", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verify-backlog-"));
    await mkdir(join(root, "raw"), { recursive: true });
    await mkdir(join(root, "var", "compile"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes on first run (no prior snapshot)", async () => {
    await writeFile(join(root, "raw", "a.md"), "content");
    await writeCompileStateFile(root, { consumed: {}, compressed: {} });
    const result = await checkBacklogGrowth({
      vaultRoot: root,
      now: () => new Date(),
    });
    expect(result.status).toBe("pass");
    expect(result.label).toMatch(/first backlog snapshot/i);
  });

  it("passes when backlog decreased", async () => {
    // Write a small file with a consumed watermark that leaves a small tail
    const content = "small";
    await writeFile(join(root, "raw", "a.md"), content);
    await writeCompileStateFile(root, {
      consumed: {
        "raw/a.md": { bytes: 1 },
      },
      compressed: {},
      lastVerifyBacklogBytes: 99999,
    });
    const result = await checkBacklogGrowth({
      vaultRoot: root,
      now: () => new Date(),
    });
    expect(result.status).toBe("pass");
    expect(result.label).toMatch(/shrank/i);
  });

  it("warns when backlog grew", async () => {
    // Write a large file with a consumed watermark leaving a big tail
    const bigContent = "x".repeat(500_000);
    await writeFile(join(root, "raw", "big.md"), bigContent);
    await writeCompileStateFile(root, {
      consumed: {
        "raw/big.md": { bytes: 1 },
      },
      compressed: {},
      lastVerifyBacklogBytes: 1000,
    });
    const result = await checkBacklogGrowth({
      vaultRoot: root,
      now: () => new Date(),
    });
    expect(result.status).toBe("warn");
    expect(result.label).toMatch(/grew/i);
  });

  it("records currentBytes into state for next run", async () => {
    await writeFile(join(root, "raw", "a.md"), "content");
    await writeCompileStateFile(root, { consumed: {}, compressed: {} });
    await checkBacklogGrowth({ vaultRoot: root, now: () => new Date() });

    const updated = await readCompileStateFile(root);
    expect(typeof updated.lastVerifyBacklogBytes).toBe("number");
  });
});
