import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleAutoPush, readPendingFile, isBusyPendingFileLockError } from "../../src/sync/auto-push.js";

interface SpawnCall {
  cmd: string;
  args: string[];
  opts?: Record<string, unknown>;
}

function makeSpawn() {
  const calls: SpawnCall[] = [];
  const spawnFn = (cmd: string, args: string[], opts?: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return { pid: 1234, unref() {} };
  };
  return { calls, spawnFn };
}

describe("scheduleAutoPush", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "auto-push-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("scheduleAutoPush writes a token to .auto-push-pending", async () => {
    const { spawnFn } = makeSpawn();
    const now = () => new Date("2026-06-03T11:55:00.000Z");

    const result = await scheduleAutoPush({ memoryRoot: tmp, spawnFn: spawnFn as never, now });
    const pending = await readPendingFile(tmp);
    const lastScheduled = await readFile(join(tmp, ".auto-push-last-scheduled"), "utf-8");

    expect(result.scheduled).toBe(true);
    expect(pending?.token).toMatch(/^[a-f0-9]{16}$/);
    expect(pending?.scheduledAt).toBe("2026-06-03T11:55:00.000Z");
    expect(pending?.debounceMs).toBe(5000);
    expect(lastScheduled.trim()).toBe("2026-06-03T11:55:00.000Z");
  });

  it("scheduleAutoPush invokes spawn with worker path + memoryRoot + token", async () => {
    const { calls, spawnFn } = makeSpawn();

    const result = await scheduleAutoPush({
      memoryRoot: tmp,
      workerPath: "C:/repo/dist/sync/auto-push-worker.mjs",
      spawnFn: spawnFn as never,
    });

    expect(calls[0]?.cmd).toBe("node");
    expect(calls[0]?.args).toEqual(["C:/repo/dist/sync/auto-push-worker.mjs", tmp, result.token]);
  });

  it("scheduleAutoPush spawn options are detached, stdio ignore, windowsHide true", async () => {
    const { calls, spawnFn } = makeSpawn();

    await scheduleAutoPush({ memoryRoot: tmp, spawnFn: spawnFn as never });

    expect(calls[0]?.opts).toMatchObject({
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("Two rapid scheduleAutoPush calls leave only the second token", async () => {
    const { spawnFn } = makeSpawn();

    await scheduleAutoPush({ memoryRoot: tmp, spawnFn: spawnFn as never });
    const second = await scheduleAutoPush({ memoryRoot: tmp, spawnFn: spawnFn as never });
    const pending = await readPendingFile(tmp);

    expect(pending?.token).toBe(second.token);
  });

  it("skips scheduling quietly when the pending-file lock is already held", async () => {
    const { calls, spawnFn } = makeSpawn();
    await writeFile(join(tmp, ".auto-push-pending.lock"), "locked");

    const result = await scheduleAutoPush({ memoryRoot: tmp, spawnFn: spawnFn as never });

    expect(result).toEqual({ scheduled: false, reason: "busy" });
    expect(calls).toHaveLength(0);
    expect(existsSync(join(tmp, "errors.log"))).toBe(false);
  });

  it("treats Windows lock EPERM on an existing pending lock as busy", async () => {
    const lockPath = join(tmp, ".auto-push-pending.lock");
    await writeFile(lockPath, "locked");

    expect(isBusyPendingFileLockError(Object.assign(new Error("locked"), { code: "EPERM" }), lockPath)).toBe(true);
  });

  it("handles concurrent schedule attempts without errors.log entries", async () => {
    const { calls, spawnFn } = makeSpawn();

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () => scheduleAutoPush({ memoryRoot: tmp, spawnFn: spawnFn as never })),
    );

    expect(attempts.every((attempt) => attempt.status === "fulfilled")).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(existsSync(join(tmp, "errors.log"))).toBe(false);
  });
});
