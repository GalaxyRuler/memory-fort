import { mkdtemp, open, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLockTimeoutError, withFileLock } from "../../src/storage/file-lock.js";

describe("withFileLock", () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-lock-test-"));
    target = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the operation and removes the lock file afterwards", async () => {
    const result = await withFileLock(target, async () => {
      expect(existsSync(`${target}.lock`)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("removes the lock file when the operation throws", async () => {
    await expect(
      withFileLock(target, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("serializes concurrent critical sections", async () => {
    const events: string[] = [];
    const slow = withFileLock(target, async () => {
      events.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 200));
      events.push("a-end");
    }, { pollMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fast = withFileLock(target, async () => {
      events.push("b-start");
    }, { pollMs: 20 });
    await Promise.all([slow, fast]);
    expect(events).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("breaks a stale lock left by a crashed process", async () => {
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, JSON.stringify({ pid: 99999, acquiredAt: "2020-01-01T00:00:00Z" }));
    const oldSeconds = (Date.now() - 120_000) / 1000;
    await utimes(lockPath, oldSeconds, oldSeconds);

    const result = await withFileLock(target, async () => "recovered", { staleMs: 30_000 });
    expect(result).toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("breaks a stale lock held by a dead process", async () => {
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: 999999,
      host: hostname(),
      acquiredAt: "2020-01-01T00:00:00Z",
    }));
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);
    let ran = false;

    await withFileLock(target, async () => {
      ran = true;
    }, { staleMs: 1000, timeoutMs: 2000, pollMs: 20 });

    expect(ran).toBe(true);
  });

  it("does not break a stale lock held by a live process", async () => {
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      host: hostname(),
      acquiredAt: "2020-01-01T00:00:00Z",
    }));
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    await expect(
      withFileLock(target, async () => undefined, { staleMs: 1000, timeoutMs: 800, pollMs: 20 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
  });

  it("throws FileLockTimeoutError when a fresh lock is held past timeoutMs", async () => {
    const lockPath = `${target}.lock`;
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    await handle.close();
    await expect(
      withFileLock(target, async () => "unreachable", { timeoutMs: 300, pollMs: 50, staleMs: 60_000 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect((await stat(lockPath)).isFile()).toBe(true);
  });
});
