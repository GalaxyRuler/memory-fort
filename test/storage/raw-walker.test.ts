import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRawMarkdownFiles } from "../../src/storage/raw-walker.js";

describe("listRawMarkdownFiles", () => {
  it("skips case-variant archive and dot/system path components under raw/", async () => {
    const root = await mkdtemp(join(tmpdir(), "raw-walk-"));
    await mkdir(join(root, "raw", "2026-07-17"), { recursive: true });
    await mkdir(join(root, "raw", ".compact-archive", "2026-07-17"), { recursive: true });
    await mkdir(join(root, "raw", "Archive", "2026-07-17"), { recursive: true });
    await mkdir(join(root, "raw", "_archive", "2026-07-17"), { recursive: true });
    await writeFile(join(root, "raw", "2026-07-17", "a.md"), "live", "utf-8");
    await writeFile(join(root, "raw", "2026-07-17", ".hidden.md"), "dot-file", "utf-8");
    await writeFile(join(root, "raw", ".compact-archive", "2026-07-17", "a.md"), "archived body", "utf-8");
    await writeFile(join(root, "raw", "Archive", "2026-07-17", "a.md"), "case archive", "utf-8");
    await writeFile(join(root, "raw", "_archive", "2026-07-17", "a.md"), "maintenance archive", "utf-8");

    const files = await listRawMarkdownFiles(root);

    expect(files.map((f) => f.relPath)).toEqual(["raw/2026-07-17/a.md"]);
    expect(files[0]!.size).toBe(4);
    expect(files[0]!.mtimeMs).toBeGreaterThan(0);
    expect(files[0]!.fullPath).toBe(join(root, "raw", "2026-07-17", "a.md"));
  });

  it("returns [] when raw/ does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "raw-walk-empty-"));
    expect(await listRawMarkdownFiles(root)).toEqual([]);
  });

  it("sorts by relPath and only includes .md files", async () => {
    const root = await mkdtemp(join(tmpdir(), "raw-walk-sort-"));
    await mkdir(join(root, "raw", "2026-07-17"), { recursive: true });
    await writeFile(join(root, "raw", "2026-07-17", "b.md"), "b", "utf-8");
    await writeFile(join(root, "raw", "2026-07-17", "a.md"), "a", "utf-8");
    await writeFile(join(root, "raw", "2026-07-17", "notes.txt"), "not markdown", "utf-8");

    const files = await listRawMarkdownFiles(root);
    expect(files.map((f) => f.relPath)).toEqual(["raw/2026-07-17/a.md", "raw/2026-07-17/b.md"]);
  });
});
