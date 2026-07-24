import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendBlock,
  ensureRawCaptureEpoch,
  ensureRawSessionFile,
  getCaptureSpoolStatus,
  rawCaptureEpochPath,
} from "../../src/hooks/raw-file.js";
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
    await ensureRawSessionFile({
      tool: "codex",
      sessionId: "next-hook",
      cwd: "C:/work",
      now: new Date("2026-07-23T04:00:06.000Z"),
    });
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

  it("quarantines a legacy event instead of recreating its missing raw path", async () => {
    const missingRaw = join(root, "raw", "forgotten-legacy.md");
    const legacyPath = join(captureSpoolDir(), "legacy-missing-raw.json");
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({
      version: 1,
      id: "legacy-missing-raw-event",
      hash: "legacy-missing-raw-hash",
      rawPath: missingRaw,
      block: "LEGACY-MUST-NOT-RESURRECT",
      createdAt: "2026-07-23T04:00:00.000Z",
    }), "utf-8");

    await ensureRawSessionFile({
      tool: "codex",
      sessionId: "legacy-drain-trigger",
      cwd: "C:/work",
      now: new Date("2026-07-23T04:00:01.000Z"),
    });
    await appendBlock({
      tool: "codex",
      sessionId: "legacy-drain-trigger",
      block: "trigger",
      now: new Date("2026-07-23T04:00:01.000Z"),
    });

    await expect(access(missingRaw)).rejects.toThrow();
    expect(await readFile(legacyPath, "utf-8")).toContain("LEGACY-MUST-NOT-RESURRECT");
    await expect(getCaptureSpoolStatus()).resolves.toMatchObject({
      pendingEventCount: 1,
      drainFailures: 1,
    });
  });

  it.each(["missing", "corrupt"] as const)(
    "preserves an epoch-bearing event when its epoch state is %s",
    async (stateFailure) => {
      const replayPath = join(root, "raw", `epoch-${stateFailure}.md`);
      await mkdir(join(root, "raw"), { recursive: true });
      await writeFile(replayPath, "live raw remains unchanged\n", "utf-8");
      const captureEpoch = await ensureRawCaptureEpoch(replayPath);
      const eventPath = join(captureSpoolDir(), `epoch-${stateFailure}.json`);
      await writeFile(eventPath, JSON.stringify({
        version: 2,
        id: `epoch-${stateFailure}-event`,
        hash: `epoch-${stateFailure}-hash`,
        rawPath: replayPath,
        block: "UNVERIFIABLE-EPOCH-MUST-NOT-APPEND",
        createdAt: "2026-07-23T04:00:00.000Z",
        captureEpoch,
      }), "utf-8");
      if (stateFailure === "missing") await rm(rawCaptureEpochPath(replayPath));
      else await writeFile(rawCaptureEpochPath(replayPath), "not-json", "utf-8");

      await ensureRawSessionFile({
        tool: "codex",
        sessionId: `epoch-${stateFailure}-trigger`,
        cwd: "C:/work",
        now: new Date("2026-07-23T04:00:01.000Z"),
      });
      await appendBlock({
        tool: "codex",
        sessionId: `epoch-${stateFailure}-trigger`,
        block: "trigger",
        now: new Date("2026-07-23T04:00:01.000Z"),
      });

      expect(await readFile(replayPath, "utf-8")).not.toContain("UNVERIFIABLE-EPOCH-MUST-NOT-APPEND");
      expect(existsSync(eventPath)).toBe(true);
      await expect(getCaptureSpoolStatus()).resolves.toMatchObject({
        pendingEventCount: 1,
        drainFailures: 1,
      });
    },
  );

  it("persists a real replay failure for a fresh status reader after the hook exits", async () => {
    await writeReplayEvent("child-failure.json", {
      id: "child-failure-event",
      hash: "child-failure-hash",
      rawPath: root,
      block: "child replay failure payload",
      createdAt: "2026-07-23T04:00:00.000Z",
    });
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
      await writeReplayEvent(name, {
        id,
        hash: `${id}-hash`,
        rawPath,
        block: `\n## [04:00:00] Prompt\n\n${id}\n`,
        createdAt: now.toISOString(),
      });
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
    await writeReplayEvent("concurrent.json", {
      id: "concurrent-replay-event",
      hash: "concurrent-replay-hash",
      rawPath: replayPath,
      block: "\n## [04:00:00] Prompt\n\nconcurrent-replay-payload\n",
      createdAt: "2026-07-23T04:00:00.000Z",
    });
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

  it("persists the current capture when replay-failure telemetry cannot be written", async () => {
    const now = new Date("2026-07-23T04:00:00.000Z");
    const currentPath = await ensureRawSessionFile({
      tool: "codex",
      sessionId: "telemetry-current",
      cwd: "C:/work",
      now,
    });
    await writeReplayEvent("failed-replay.json", {
      id: "telemetry-failure-event",
      hash: "telemetry-failure-hash",
      rawPath: root,
      block: "prior replay failure",
      createdAt: now.toISOString(),
    });
    await mkdir(join(captureSpoolDir(), "capture-drain-failures.jsonl"));

    await expect(appendBlock({
      tool: "codex",
      sessionId: "telemetry-current",
      block: "\n## [04:00:01] Prompt\n\ncurrent-survives-telemetry-failure\n",
      now: new Date("2026-07-23T04:00:01.000Z"),
    })).resolves.toBeUndefined();

    expect(await readFile(currentPath, "utf-8")).toContain("current-survives-telemetry-failure");
    expect((await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"))).toEqual([
      "failed-replay.json",
    ]);
  });

  it("persists the current capture when replay cursor state cannot be written", async () => {
    const now = new Date("2026-07-23T04:00:00.000Z");
    const currentPath = await ensureRawSessionFile({
      tool: "codex",
      sessionId: "cursor-current",
      cwd: "C:/work",
      now,
    });
    const replayPath = join(root, "cursor-replay.md");
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(replayPath, "", "utf-8");
    await writeReplayEvent("cursor-replay.json", {
      id: "cursor-replay-event",
      hash: "cursor-replay-hash",
      rawPath: replayPath,
      block: "cursor replay payload",
      createdAt: now.toISOString(),
    });
    await mkdir(join(captureSpoolDir(), "capture-replay-cursor.txt"));

    await expect(appendBlock({
      tool: "codex",
      sessionId: "cursor-current",
      block: "\n## [04:00:01] Prompt\n\ncurrent-survives-cursor-failure\n",
      now: new Date("2026-07-23T04:00:01.000Z"),
    })).resolves.toBeUndefined();

    expect(await readFile(currentPath, "utf-8")).toContain("current-survives-cursor-failure");
  });

  it("rotates bounded replay past permanent leading failures across hook processes", async () => {
    const drainablePath = join(root, "eventually-drained.md");
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(drainablePath, "", "utf-8");
    const entries = [
      ["01-permanent.json", "permanent-one", root, "permanent-one-payload"],
      ["02-permanent.json", "permanent-two", root, "permanent-two-payload"],
      ["03-drainable.json", "drainable-three", drainablePath, "drainable-three-payload"],
    ] as const;
    for (const [name, id, rawPath, payload] of entries) {
      await writeReplayEvent(name, {
        id,
        hash: `${id}-hash`,
        rawPath,
        block: `\n## [04:00:00] Prompt\n\n${payload}\n`,
        createdAt: "2026-07-23T04:00:00.000Z",
      });
    }
    const viteNode = join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs");
    const fixture = join(process.cwd(), "test", "fixtures", "capture-replay-failure-child.ts");
    const runHook = () => promisify(execFile)(process.execPath, [viteNode, fixture], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MEMORY_ROOT: root,
        MEMORY_CAPTURE_SPOOL_DIR: captureSpoolDir(),
      },
      windowsHide: true,
      timeout: 10_000,
    });

    await runHook();
    expect(await readFile(drainablePath, "utf-8")).toBe("");
    await runHook();

    expect(await readFile(drainablePath, "utf-8")).toContain("drainable-three-payload");
    expect((await readdir(captureSpoolDir())).filter((name) => name.endsWith(".json"))).toEqual([
      "01-permanent.json",
      "02-permanent.json",
    ]);
  });

  it("counts one real failed opportunistic drain exactly once", async () => {
    await mkdir(captureSpoolDir(), { recursive: true });
    await writeFile(join(captureSpoolDir(), "malformed.json"), "not-json", "utf-8");
    await writeReplayEvent("failed-drain.json", {
      id: "failed-drain-event",
      hash: "failed-drain-hash",
      rawPath: root,
      block: "failed drain payload",
      createdAt: "2026-07-23T04:00:00.000Z",
    });

    await ensureRawSessionFile({
      tool: "codex",
      sessionId: "next-hook",
      cwd: "C:/work",
      now: new Date("2026-07-23T04:00:01.000Z"),
    });
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
    await ensureRawSessionFile({ tool: "codex", sessionId: "next-hook", cwd: "C:/work", now });
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

  async function writeReplayEvent(
    name: string,
    event: {
      id: string;
      hash: string;
      rawPath: string;
      block: string;
      createdAt: string;
    },
  ): Promise<void> {
    await mkdir(captureSpoolDir(), { recursive: true });
    const captureEpoch = await ensureRawCaptureEpoch(event.rawPath);
    await writeFile(join(captureSpoolDir(), name), JSON.stringify({
      version: 2,
      ...event,
      captureEpoch,
    }), "utf-8");
  }
});
