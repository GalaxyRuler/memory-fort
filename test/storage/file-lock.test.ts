import { mkdtemp, open, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLockTimeoutError, isLockContentionError, withFileLock } from "../../src/storage/file-lock.js";

describe("isLockContentionError", () => {
  it("treats EEXIST, EPERM, and EACCES as contention (Windows delete-pending parity)", () => {
    expect(isLockContentionError(Object.assign(new Error("x"), { code: "EEXIST" }))).toBe(true);
    expect(isLockContentionError(Object.assign(new Error("x"), { code: "EPERM" }))).toBe(true);
    expect(isLockContentionError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(true);
  });
  it("does not treat unrelated errors as contention", () => {
    expect(isLockContentionError(Object.assign(new Error("x"), { code: "ENOSPC" }))).toBe(false);
    expect(isLockContentionError(new Error("no code"))).toBe(false);
    expect(isLockContentionError(null)).toBe(false);
  });
});

describe("withFileLock", () => {
  let dir: string;
  let target: string;
  let children: ChildProcessWithoutNullStreams[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "file-lock-test-"));
    target = join(dir, "state.json");
    children = [];
  });

  afterEach(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode === null) child.kill();
      await waitForChildExit(child).catch(() => undefined);
    }));
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

  it("breaks a legacy stale same-host lock left by a confirmed dead process", async () => {
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: 99999,
      host: hostname(),
      acquiredAt: "2020-01-01T00:00:00Z",
    }));
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

  it("does not steal a stale lock owned by a foreign host", async () => {
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: 999999,
      host: "foreign-host.example",
      ownerToken: "foreign-owner-token",
      acquiredAt: "2020-01-01T00:00:00Z",
    }));
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    await expect(
      withFileLock(target, async () => undefined, { staleMs: 20, timeoutMs: 150, pollMs: 10 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("heartbeats an actual child-process owner beyond the stale threshold", async () => {
    const releasePath = join(dir, "release-heartbeat");
    const child = spawnOwnerChild(target, releasePath, 80, 20);
    children.push(child);
    await waitForChildLine(child, "LOCKED");
    const lockPath = `${target}.lock`;
    const initialMtime = (await stat(lockPath)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterStaleThresholdMtime = (await stat(lockPath)).mtimeMs;
    expect(afterStaleThresholdMtime).toBeGreaterThan(initialMtime);
    await waitFor(async () => (await stat(lockPath)).mtimeMs > afterStaleThresholdMtime, 1_000);
    await expect(
      withFileLock(target, async () => undefined, { staleMs: 80, timeoutMs: 120, pollMs: 10 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);

    await writeFile(releasePath, "release\n", "utf-8");
    await expect(waitForChildExit(child)).resolves.toBe(0);
  });

  it("does not let an old child owner unlink a successor lock", async () => {
    const releasePath = join(dir, "release-replaced-owner");
    const child = spawnOwnerChild(target, releasePath, 200, 40);
    children.push(child);
    await waitForChildLine(child, "LOCKED");
    const lockPath = `${target}.lock`;

    await unlink(lockPath);
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      host: hostname(),
      ownerToken: "successor-owner-token",
      acquiredAt: new Date().toISOString(),
    }));
    await writeFile(releasePath, "release\n", "utf-8");
    await expect(waitForChildExit(child)).resolves.toBe(0);

    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(await readFile(lockPath, "utf-8"))).toMatchObject({
      ownerToken: "successor-owner-token",
    });
  });

  it("recovers a stale lock abandoned by a terminated same-host child", async () => {
    const releasePath = join(dir, "never-release-dead-owner");
    const child = spawnOwnerChild(target, releasePath, 1_000, 100);
    children.push(child);
    await waitForChildLine(child, "LOCKED");
    const lockPath = `${target}.lock`;
    child.kill();
    await waitForChildExit(child);
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    await expect(withFileLock(
      target,
      async () => "recovered",
      { staleMs: 20, timeoutMs: 1_000, pollMs: 10 },
    )).resolves.toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("lets only one real reaper reclaim while the successor lock survives", async () => {
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: 999999,
      host: hostname(),
      ownerToken: "abandoned-owner-token",
      acquiredAt: "2020-01-01T00:00:00Z",
    }));
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    const startPath = join(dir, "reapers-start");
    const reclaimReleasePath = join(dir, "reapers-release-reclaim");
    const releaseA = join(dir, "release-reaper-a");
    const releaseB = join(dir, "release-reaper-b");
    const childA = spawnReaperChild("a", target, startPath, reclaimReleasePath, releaseA);
    const childB = spawnReaperChild("b", target, startPath, reclaimReleasePath, releaseB);
    children.push(childA, childB);
    const outputA = observeChild(childA);
    const outputB = observeChild(childB);
    await waitFor(
      async () => outputA.lines.includes("READY:a") && outputB.lines.includes("READY:b"),
      5_000,
    );

    await writeFile(startPath, "start\n", "utf-8");
    await waitFor(
      async () => outputA.lines.includes("SNAPSHOT:a") && outputB.lines.includes("SNAPSHOT:b"),
      5_000,
    );
    await writeFile(reclaimReleasePath, "release\n", "utf-8");
    await waitFor(
      async () => [...outputA.lines, ...outputB.lines].some((line) => line.startsWith("RECLAIMED:")),
      5_000,
    );
    await waitFor(
      async () => [...outputA.lines, ...outputB.lines].some((line) => line.startsWith("ENTERED:")),
      5_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    const entered = [...outputA.lines, ...outputB.lines].filter((line) => line.startsWith("ENTERED:"));
    const reclaimed = [...outputA.lines, ...outputB.lines].filter((line) => line.startsWith("RECLAIMED:"));
    expect(entered).toHaveLength(1);
    expect(reclaimed).toHaveLength(1);
    const [, firstId, firstToken] = entered[0]!.split(":");
    expect(JSON.parse(await readFile(lockPath, "utf-8"))).toMatchObject({ ownerToken: firstToken });

    await writeFile(firstId === "a" ? releaseA : releaseB, "release\n", "utf-8");
    await expect(waitForChildExit(firstId === "a" ? childA : childB)).resolves.toBe(0);
    const secondOutput = firstId === "a" ? outputB : outputA;
    const secondId = firstId === "a" ? "b" : "a";
    await waitFor(
      async () => secondOutput.lines.some((line) => line.startsWith(`ENTERED:${secondId}:`)),
      5_000,
    );
    const secondEntered = secondOutput.lines.find((line) => line.startsWith(`ENTERED:${secondId}:`))!;
    const secondToken = secondEntered.split(":")[2];
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(await readFile(lockPath, "utf-8"))).toMatchObject({ ownerToken: secondToken });
    expect([...outputA.lines, ...outputB.lines].filter((line) => line.startsWith("RECLAIMED:"))).toHaveLength(1);

    await writeFile(secondId === "a" ? releaseA : releaseB, "release\n", "utf-8");
    await expect(waitForChildExit(secondId === "a" ? childA : childB)).resolves.toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  }, 15_000);

  it("restores rather than deletes a successor that appears after the stale snapshot", async () => {
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: 999999,
      host: hostname(),
      ownerToken: "abandoned-owner-token",
      acquiredAt: "2020-01-01T00:00:00Z",
    }));
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);
    let successorInstalled = false;

    await expect(withFileLock(target, async () => "must-not-enter", {
      staleMs: 20,
      timeoutMs: 150,
      pollMs: 10,
      testHooks: {
        afterStaleSnapshotConfirmed: async () => {
          if (successorInstalled) return;
          successorInstalled = true;
          await unlink(lockPath);
          await writeFile(lockPath, JSON.stringify({
            pid: process.pid,
            host: hostname(),
            ownerToken: "successor-after-snapshot-token",
            acquiredAt: new Date().toISOString(),
          }));
        },
      },
    })).rejects.toBeInstanceOf(FileLockTimeoutError);

    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(await readFile(lockPath, "utf-8"))).toMatchObject({
      ownerToken: "successor-after-snapshot-token",
    });
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

function spawnOwnerChild(
  target: string,
  releasePath: string,
  staleMs: number,
  heartbeatMs: number,
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"),
    join(process.cwd(), "test", "fixtures", "file-lock-owner-child.ts"),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MEMORY_TEST_LOCK_TARGET: target,
      MEMORY_TEST_LOCK_RELEASE: releasePath,
      MEMORY_TEST_LOCK_STALE_MS: String(staleMs),
      MEMORY_TEST_LOCK_HEARTBEAT_MS: String(heartbeatMs),
    },
    windowsHide: true,
  });
}

function spawnReaperChild(
  id: string,
  target: string,
  startPath: string,
  reclaimReleasePath: string,
  operationReleasePath: string,
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"),
    join(process.cwd(), "test", "fixtures", "file-lock-reaper-child.ts"),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MEMORY_TEST_REAPER_ID: id,
      MEMORY_TEST_LOCK_TARGET: target,
      MEMORY_TEST_REAPER_START: startPath,
      MEMORY_TEST_RECLAIM_RELEASE: reclaimReleasePath,
      MEMORY_TEST_LOCK_RELEASE: operationReleasePath,
    },
    windowsHide: true,
  });
}

function observeChild(child: ChildProcessWithoutNullStreams): { lines: string[] } {
  const lines: string[] = [];
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf-8");
    const complete = pending.split(/\r?\n/);
    pending = complete.pop() ?? "";
    lines.push(...complete.filter((line) => line.length > 0));
  });
  return { lines };
}

function waitForChildLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`child did not emit ${expected}; stderr=${stderr}`)), 5_000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      if (stdout.includes(expected)) finish();
    };
    const onStderr = (chunk: Buffer) => { stderr += chunk.toString("utf-8"); };
    const onExit = (code: number | null) => finish(new Error(`child exited ${code}; stderr=${stderr}`));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("timed out waiting for child exit"));
    }, 5_000);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      resolve(code);
    };
    child.once("exit", onExit);
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
