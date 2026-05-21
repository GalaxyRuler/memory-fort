import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, atomicAppend } from "../src/storage/atomic-write.js";

describe("atomic-write", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "memtest-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("atomicWrite creates file with content", async () => {
    const p = join(dir, "test.md");
    await atomicWrite(p, "hello");
    expect((await readFile(p, "utf-8"))).toBe("hello");
  });

  it("atomicWrite creates parent directories", async () => {
    const p = join(dir, "a", "b", "c", "test.md");
    await atomicWrite(p, "deep");
    expect((await readFile(p, "utf-8"))).toBe("deep");
  });

  it("atomicWrite overwrites existing file atomically", async () => {
    const p = join(dir, "test.md");
    await atomicWrite(p, "first");
    await atomicWrite(p, "second");
    expect((await readFile(p, "utf-8"))).toBe("second");
  });

  it("atomicAppend appends to existing file", async () => {
    const p = join(dir, "test.md");
    await atomicWrite(p, "line1\n");
    await atomicAppend(p, "line2\n");
    expect((await readFile(p, "utf-8"))).toBe("line1\nline2\n");
  });

  it("atomicAppend creates file if missing", async () => {
    const p = join(dir, "new.md");
    await atomicAppend(p, "fresh");
    expect((await readFile(p, "utf-8"))).toBe("fresh");
  });

  it("concurrent atomicAppend produces N lines, no corruption", async () => {
    const p = join(dir, "concurrent.md");
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => atomicAppend(p, `line${i}\n`)),
    );
    const content = await readFile(p, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(10);
    // Each line is one of line0..line9; order may vary
    expect(new Set(lines).size).toBe(10);
    expect(lines.every((l) => /^line\d$/.test(l))).toBe(true);
  });
});
