import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCompileRawAppendOnly } from "../../../../src/cli/commands/verify/compile-raw-append-only.js";
import { writeCompileStateFile } from "../../../../src/compile/state.js";

describe("compile.raw-append-only verify check", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verify-raw-append-only-"));
    await mkdir(join(root, "raw"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes when no consumed watermarks exist", async () => {
    const result = await checkCompileRawAppendOnly({
      vaultRoot: root,
      now: () => new Date("2026-06-17T00:00:00.000Z"),
    });

    expect(result.status).toBe("pass");
  });

  it("passes when current raw size is at least the consumed watermark", async () => {
    await writeRaw("raw/a.md", "abcdef");
    await writeCompileStateFile(root, {
      consumed: {
        "raw/a.md": { bytes: 3 },
      },
    });

    const result = await checkCompileRawAppendOnly({
      vaultRoot: root,
      now: () => new Date("2026-06-17T00:00:00.000Z"),
    });

    expect(result.status).toBe("pass");
  });

  it("fails when a raw file shrank below its consumed watermark", async () => {
    await writeRaw("raw/a.md", "abc");
    await writeCompileStateFile(root, {
      consumed: {
        "raw/a.md": { bytes: 5 },
      },
    });

    const result = await checkCompileRawAppendOnly({
      vaultRoot: root,
      now: () => new Date("2026-06-17T00:00:00.000Z"),
    });

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("raw/a.md");
    expect(result.detail).toContain("3 B < 5 B");
  });

  it("lists multiple files that shrank below their consumed watermarks", async () => {
    await writeRaw("raw/a.md", "abc");
    await writeRaw("raw/b.md", "1234");
    await writeCompileStateFile(root, {
      consumed: {
        "raw/a.md": { bytes: 5 },
        "raw/b.md": { bytes: 9 },
      },
    });

    const result = await checkCompileRawAppendOnly({
      vaultRoot: root,
      now: () => new Date("2026-06-17T00:00:00.000Z"),
    });

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("raw/a.md");
    expect(result.detail).toContain("raw/b.md");
  });

  it("ignores deleted raw files", async () => {
    await writeCompileStateFile(root, {
      consumed: {
        "raw/deleted.md": { bytes: 100 },
      },
    });

    const result = await checkCompileRawAppendOnly({
      vaultRoot: root,
      now: () => new Date("2026-06-17T00:00:00.000Z"),
    });

    expect(result.status).toBe("pass");
  });

  async function writeRaw(relPath: string, content: string): Promise<void> {
    const fullPath = join(root, ...relPath.split("/"));
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});
