import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("atomicAppend durability", () => {
  let dir: string | null = null;

  afterEach(async () => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("flushes the successful append before reporting it", async () => {
    dir = await mkdtemp(join(tmpdir(), "memtest-append-durable-"));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const appendFile = vi.fn(actual.appendFile);
    vi.doMock("node:fs/promises", () => ({ ...actual, appendFile }));
    const { atomicAppend } = await import("../src/storage/atomic-write.js");
    const path = join(dir, "capture.md");

    await atomicAppend(path, "durable capture\n");

    expect(await readFile(path, "utf-8")).toBe("durable capture\n");
    expect(appendFile).toHaveBeenCalledWith(path, "durable capture\n", {
      encoding: "utf-8",
      flush: true,
    });
  });

  it("does not let a child process report success before the file sync boundary completes", async () => {
    dir = await mkdtemp(join(tmpdir(), "memtest-append-process-boundary-"));
    const target = join(dir, "capture.md");
    const syncMarker = join(dir, "sync-completed.txt");
    const viteNode = join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs");
    const fixture = join(process.cwd(), "test", "fixtures", "atomic-append-process-boundary.ts");

    await promisify(execFile)(process.execPath, [viteNode, fixture], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEMORY_TEST_APPEND_TARGET: target,
        MEMORY_TEST_SYNC_MARKER: syncMarker,
      },
      windowsHide: true,
      timeout: 10_000,
    });

    expect(await readFile(target, "utf-8")).toBe("child-process capture\n");
    expect(await readFile(syncMarker, "utf-8")).toBe("sync completed\n");
  });
});
