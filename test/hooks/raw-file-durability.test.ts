import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { appendBlock, ensureRawSessionFile, getCaptureSpoolStatus } from "../../src/hooks/raw-file.js";
import { captureSpoolDir } from "../../src/storage/paths.js";

describe("durable raw capture", () => {
  let root: string;
  let previousRoot: string | undefined;
  let previousSpool: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "memtest-durable-capture-"));
    previousRoot = process.env["MEMORY_ROOT"];
    previousSpool = process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    process.env["MEMORY_ROOT"] = root;
    process.env["MEMORY_CAPTURE_SPOOL_DIR"] = join(root, "installation-state", "capture-spool");
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = previousRoot;
    if (previousSpool === undefined) delete process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    else process.env["MEMORY_CAPTURE_SPOOL_DIR"] = previousSpool;
    await rm(root, { recursive: true, force: true });
  });

  it("spools a capture during real session-lock contention instead of appending unlocked", async () => {
    const now = new Date(Date.UTC(2026, 6, 23, 4, 0, 0));
    const path = await ensureRawSessionFile({
      tool: "codex",
      sessionId: "locked-session",
      cwd: "C:/work",
      now,
    });
    await writeFile(`${path}.lock`, "another process holds this lock", "utf-8");

    await appendBlock({
      tool: "codex",
      sessionId: "locked-session",
      block: "\n## [04:00:00] Prompt\n\nspooled-not-unlocked\n",
      now,
    });

    expect(await readFile(path, "utf-8")).not.toContain("spooled-not-unlocked");
    const files = (await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(await readFile(join(captureSpoolDir(), files[0]!), "utf-8")).toContain("spooled-not-unlocked");
  }, 20_000);

  it("keeps a capture_spooled diagnostic observable after a successful drain", async () => {
    const now = new Date("2026-07-23T04:00:00.000Z");
    const path = await ensureRawSessionFile({
      tool: "codex",
      sessionId: "diagnostic-session",
      cwd: "C:/work",
      now,
    });
    await writeFile(`${path}.lock`, "another process holds this lock", "utf-8");

    await appendBlock({
      tool: "codex",
      sessionId: "diagnostic-session",
      block: "\n## [04:00:00] Prompt\n\ndiagnostic-payload\n",
      now,
    });
    const [spoolName] = (await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"));
    const event = JSON.parse(await readFile(join(captureSpoolDir(), spoolName!), "utf-8")) as {
      id: string;
      hash: string;
    };
    expect(await getCaptureSpoolStatus(new Date("2026-07-23T04:00:05.000Z"))).toMatchObject({
      pendingEventCount: 1,
      oldestPendingAgeMs: 5_000,
      captureSpooled: [{
        type: "capture_spooled",
        eventId: event.id,
        hash: event.hash,
        createdAt: now.toISOString(),
      }],
    });

    await rm(`${path}.lock`);
    await appendBlock({
      tool: "codex",
      sessionId: "next-hook",
      block: "\n## [04:00:06] Prompt\n\nnext\n",
      now: new Date("2026-07-23T04:00:06.000Z"),
    });

    vi.resetModules();
    const restarted = await import("../../src/hooks/raw-file.js");
    expect(await restarted.getCaptureSpoolStatus()).toMatchObject({
      pendingEventCount: 0,
      oldestPendingAgeMs: null,
      captureSpooled: [expect.objectContaining({ eventId: event.id, hash: event.hash })],
    });
  }, 20_000);

  it("does not count passive malformed-spool status reads as drain failures", async () => {
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(join(captureSpoolDir(), "malformed.json"), "not-json", "utf-8");

    const first = await getCaptureSpoolStatus();
    const second = await getCaptureSpoolStatus();

    expect(first.drainFailures).toBe(0);
    expect(second.drainFailures).toBe(0);
  });

  it("exposes capture_spooled for a pending record created by a previous process", async () => {
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(join(captureSpoolDir(), "previous-process.json"), JSON.stringify({
      version: 1,
      id: "previous-process-event",
      hash: "previous-process-hash",
      rawPath: join(root, "raw", "capture.md"),
      block: "previous process payload",
      createdAt: "2026-07-23T04:00:00.000Z",
    }), "utf-8");

    expect(await getCaptureSpoolStatus(new Date("2026-07-23T04:00:03.000Z"))).toMatchObject({
      pendingEventCount: 1,
      oldestPendingAgeMs: 3_000,
      captureSpooled: [{
        type: "capture_spooled",
        eventId: "previous-process-event",
        hash: "previous-process-hash",
        createdAt: "2026-07-23T04:00:00.000Z",
      }],
    });
  });

  it("persists a real replay failure for a fresh status reader after the hook exits", async () => {
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(join(captureSpoolDir(), "child-failure.json"), JSON.stringify({
      version: 1,
      id: "child-failure-event",
      hash: "child-failure-hash",
      rawPath: root,
      block: "child replay failure payload",
      createdAt: "2026-07-23T04:00:00.000Z",
    }), "utf-8");
    const viteNode = join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs");
    const fixture = join(process.cwd(), "test", "fixtures", "capture-replay-failure-child.ts");

    await promisify(execFile)(process.execPath, [viteNode, fixture], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEMORY_ROOT: root,
        MEMORY_CAPTURE_SPOOL_DIR: captureSpoolDir(),
      },
      windowsHide: true,
      timeout: 10_000,
    });

    vi.resetModules();
    const restarted = await import("../../src/hooks/raw-file.js");
    expect(await restarted.getCaptureSpoolStatus()).toMatchObject({
      pendingEventCount: 1,
      drainFailures: 1,
    });
  });

  it("bounds contended replay before persisting the current capture", async () => {
    const now = new Date("2026-07-23T04:00:00.000Z");
    const currentPath = await ensureRawSessionFile({
      tool: "codex",
      sessionId: "current-capture",
      cwd: "C:/work",
      now,
    });
    const lockedReplayPath = join(root, "locked-replay.md");
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(`${lockedReplayPath}.lock`, JSON.stringify({
      pid: process.pid,
      host: hostname(),
      acquiredAt: now.toISOString(),
    }), "utf-8");
    const pending = [
      ["01-locked.json", "locked-replay", lockedReplayPath],
      ["02-fast.json", "fast-replay", join(root, "fast-replay.md")],
      ["03-deferred.json", "deferred-replay", join(root, "deferred-replay.md")],
    ] as const;
    for (const [name, id, rawPath] of pending) {
      await writeFile(join(captureSpoolDir(), name), JSON.stringify({
        version: 1,
        id,
        hash: `${id}-hash`,
        rawPath,
        block: `\n## [04:00:00] Prompt\n\n${id}\n`,
        createdAt: now.toISOString(),
      }), "utf-8");
    }

    const started = Date.now();
    await appendBlock({
      tool: "codex",
      sessionId: "current-capture",
      block: "\n## [04:00:01] Prompt\n\ncurrent-capture-durable\n",
      now: new Date("2026-07-23T04:00:01.000Z"),
    });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(await readFile(currentPath, "utf-8")).toContain("current-capture-durable");
    expect((await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"))).toEqual([
      "01-locked.json",
      "03-deferred.json",
    ]);
  }, 20_000);

  it("treats a concurrently deleted spool as already drained without recording a failure", async () => {
    const replayPath = join(root, "concurrent-replay.md");
    const readyDir = join(root, "replay-ready");
    const startPath = join(root, "start-replay");
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(join(captureSpoolDir(), "concurrent.json"), JSON.stringify({
      version: 1,
      id: "concurrent-replay-event",
      hash: "concurrent-replay-hash",
      rawPath: replayPath,
      block: "\n## [04:00:00] Prompt\n\nconcurrent-replay-payload\n",
      createdAt: "2026-07-23T04:00:00.000Z",
    }), "utf-8");
    await writeFile(`${replayPath}.lock`, JSON.stringify({
      pid: process.pid,
      host: hostname(),
      acquiredAt: new Date().toISOString(),
    }), "utf-8");
    const viteNode = join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs");
    const fixture = join(process.cwd(), "test", "fixtures", "capture-concurrent-replay-child.ts");
    const runChild = (sessionId: string) => promisify(execFile)(process.execPath, [viteNode, fixture], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEMORY_ROOT: root,
        MEMORY_CAPTURE_SPOOL_DIR: captureSpoolDir(),
        MEMORY_TEST_READY_FILE: join(readyDir, `${sessionId}.ready`),
        MEMORY_TEST_START_FILE: startPath,
        MEMORY_TEST_SESSION_ID: sessionId,
      },
      windowsHide: true,
      timeout: 10_000,
    });

    const first = runChild("concurrent-one");
    const second = runChild("concurrent-two");
    await waitForFiles([join(readyDir, "concurrent-one.ready"), join(readyDir, "concurrent-two.ready")]);
    await writeFile(startPath, "go", "utf-8");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(`${replayPath}.lock`);
    await Promise.all([first, second]);

    vi.resetModules();
    const restarted = await import("../../src/hooks/raw-file.js");
    expect((await readFile(replayPath, "utf-8")).match(/concurrent-replay-payload/g)).toHaveLength(1);
    expect((await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"))).toEqual([]);
    expect((await restarted.getCaptureSpoolStatus()).drainFailures).toBe(0);
  });

  it("counts one real failed opportunistic drain exactly once", async () => {
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(join(captureSpoolDir(), "malformed.json"), "not-json", "utf-8");
    await writeFile(join(captureSpoolDir(), "failed-drain.json"), JSON.stringify({
      version: 1,
      id: "failed-drain-event",
      hash: "failed-drain-hash",
      rawPath: root,
      block: "failed drain payload",
      createdAt: "2026-07-23T04:00:00.000Z",
    }), "utf-8");

    await appendBlock({
      tool: "codex",
      sessionId: "next-hook",
      block: "\n## [04:00:01] Prompt\n\nnext\n",
      now: new Date("2026-07-23T04:00:01.000Z"),
    });

    const first = await getCaptureSpoolStatus();
    const second = await getCaptureSpoolStatus();
    expect(first).toMatchObject({
      pendingEventCount: 1,
      drainFailures: 1,
    });
    expect(second.drainFailures).toBe(1);
  });

  it("drains a crash-left spool exactly once after its event was already merged", async () => {
    const now = new Date(Date.UTC(2026, 6, 23, 4, 1, 0));
    const path = await ensureRawSessionFile({ tool: "codex", sessionId: "crash-session", cwd: "C:/work", now });
    await writeFile(`${path}.lock`, "another process holds this lock", "utf-8");
    await appendBlock({ tool: "codex", sessionId: "crash-session", block: "\n## [04:01:00] Prompt\n\nmerge-once\n", now });
    const [spoolName] = (await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"));
    const event = JSON.parse(await readFile(join(captureSpoolDir(), spoolName!), "utf-8")) as { id: string; hash: string; block: string };

    await writeFile(path, `${await readFile(path, "utf-8")}${event.block}\n<!-- memory-fort-capture id=${event.id} hash=${event.hash} -->\n`);
    await rm(`${path}.lock`);
    await appendBlock({ tool: "codex", sessionId: "next-hook", block: "\n## [04:01:01] Prompt\n\nnext\n", now });

    expect((await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"))).toEqual([]);
    expect((await readFile(path, "utf-8")).match(/merge-once/g)).toHaveLength(1);
  }, 20_000);

  async function waitForFiles(paths: string[]): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (true) {
      const present = await Promise.all(paths.map(async (path) => {
        try { await access(path); return true; } catch { return false; }
      }));
      if (present.every(Boolean)) return;
      if (Date.now() >= deadline) throw new Error("replay children did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
});
