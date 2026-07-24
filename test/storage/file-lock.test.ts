import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileLockTimeoutError,
  isLockContentionError,
  withFileLock,
} from "../../src/storage/file-lock.js";

interface ClaimRecord {
  version: 2;
  pid: number;
  host: string;
  acquiredAt: string;
  ownerToken: string;
  choosing: boolean;
  ticket: number | null;
}

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

  it("runs the operation with one unique claim and removes only that claim afterwards", async () => {
    const result = await withFileLock(target, async () => {
      expect((await stat(lockDirectory(target))).isDirectory()).toBe(true);
      expect(await claimNames(target)).toHaveLength(1);
      return 42;
    });

    expect(result).toBe(42);
    expect((await stat(lockDirectory(target))).isDirectory()).toBe(true);
    expect(await claimNames(target)).toEqual([]);
  });

  it("removes its unique claim when the operation throws", async () => {
    await expect(withFileLock(target, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(await claimNames(target)).toEqual([]);
  });

  it("serializes concurrent critical sections in deterministic ticket order", async () => {
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

  it("waits for a live legacy lock file and permanently migrates after its owner releases", async () => {
    const legacyPath = lockDirectory(target);
    await writeFile(legacyPath, JSON.stringify({
      pid: process.pid,
      host: hostname(),
      ownerToken: "legacy-live-owner",
      acquiredAt: new Date().toISOString(),
    }));
    let entered = false;
    const contender = withFileLock(target, async () => {
      entered = true;
      expect((await stat(legacyPath)).isDirectory()).toBe(true);
    }, { timeoutMs: 1_000, pollMs: 10, staleMs: 100 });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(entered).toBe(false);
    await unlink(legacyPath);
    await contender;

    expect((await stat(legacyPath)).isDirectory()).toBe(true);
  });

  it("does not auto-delete an abandoned legacy shared path that could have a successor", async () => {
    const legacyPath = lockDirectory(target);
    await writeFile(legacyPath, JSON.stringify({
      pid: 2 ** 30,
      host: hostname(),
      ownerToken: "legacy-dead-owner",
      acquiredAt: "2020-01-01T00:00:00.000Z",
    }));
    const past = new Date(Date.now() - 60_000);
    await utimes(legacyPath, past, past);

    await expect(withFileLock(
      target,
      async () => "unreachable",
      { staleMs: 20, timeoutMs: 150, pollMs: 10 },
    )).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect((await stat(legacyPath)).isFile()).toBe(true);
  });

  it("reclaims a stale unique claim held by a confirmed dead same-host process", async () => {
    const deadPath = await seedClaim(target, {
      pid: 2 ** 30,
      host: hostname(),
      ownerToken: "dead-unique-owner",
      ticket: 1,
    });
    const past = new Date(Date.now() - 60_000);
    await utimes(deadPath, past, past);

    await expect(withFileLock(
      target,
      async () => "recovered",
      { staleMs: 20, timeoutMs: 1_000, pollMs: 10 },
    )).resolves.toBe("recovered");
    expect(existsSync(deadPath)).toBe(false);
    expect(await claimNames(target)).toEqual([]);
  });

  it("does not reclaim a stale unique claim held by a live same-host process", async () => {
    const livePath = await seedClaim(target, {
      pid: process.pid,
      host: hostname(),
      ownerToken: "live-unique-owner",
      ticket: 1,
    });
    const past = new Date(Date.now() - 60_000);
    await utimes(livePath, past, past);

    await expect(withFileLock(
      target,
      async () => undefined,
      { staleMs: 20, timeoutMs: 150, pollMs: 10 },
    )).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(existsSync(livePath)).toBe(true);
  });

  it("never auto-reclaims a foreign-host unique claim", async () => {
    const foreignPath = await seedClaim(target, {
      pid: 2 ** 30,
      host: "foreign-host.example",
      ownerToken: "foreign-unique-owner",
      ticket: 1,
    });
    const past = new Date(Date.now() - 60_000);
    await utimes(foreignPath, past, past);

    await expect(withFileLock(
      target,
      async () => undefined,
      { staleMs: 20, timeoutMs: 150, pollMs: 10 },
    )).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(existsSync(foreignPath)).toBe(true);
  });

  it("heartbeats an actual child-process claim beyond the stale threshold", async () => {
    const releasePath = join(dir, "release-heartbeat");
    const child = spawnOwnerChild(target, releasePath, 80, 20);
    children.push(child);
    await waitForChildLine(child, "LOCKED");
    const childClaim = await findClaimForPid(target, child.pid!);
    const initialMtime = (await stat(childClaim)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterStaleThresholdMtime = (await stat(childClaim)).mtimeMs;
    expect(afterStaleThresholdMtime).toBeGreaterThan(initialMtime);
    await waitFor(async () => (await stat(childClaim)).mtimeMs > afterStaleThresholdMtime, 1_000);
    await expect(withFileLock(
      target,
      async () => undefined,
      { staleMs: 80, timeoutMs: 120, pollMs: 10 },
    )).rejects.toBeInstanceOf(FileLockTimeoutError);

    await writeFile(releasePath, "release\n", "utf-8");
    await expect(waitForChildExit(child)).resolves.toBe(0);
  });

  it("an owner release deletes only its own path and cannot delete a successor claim", async () => {
    const releasePath = join(dir, "release-owner");
    const child = spawnOwnerChild(target, releasePath, 200, 40);
    children.push(child);
    await waitForChildLine(child, "LOCKED");
    const childClaim = await findClaimForPid(target, child.pid!);
    const successorPath = await seedClaim(target, {
      pid: process.pid,
      host: hostname(),
      ownerToken: "successor-unique-owner",
      ticket: 99,
    });

    await writeFile(releasePath, "release\n", "utf-8");
    await expect(waitForChildExit(child)).resolves.toBe(0);

    expect(existsSync(childClaim)).toBe(false);
    expect(existsSync(successorPath)).toBe(true);
  });

  it("recovers a stale unique claim abandoned by a terminated same-host child", async () => {
    const releasePath = join(dir, "never-release-dead-owner");
    const child = spawnOwnerChild(target, releasePath, 1_000, 100);
    children.push(child);
    await waitForChildLine(child, "LOCKED");
    const childClaim = await findClaimForPid(target, child.pid!);
    child.kill();
    await waitForChildExit(child);
    const past = new Date(Date.now() - 60_000);
    await utimes(childClaim, past, past);

    await expect(withFileLock(
      target,
      async () => "recovered",
      { staleMs: 20, timeoutMs: 1_000, pollMs: 10 },
    )).resolves.toBe("recovered");
    expect(existsSync(childClaim)).toBe(false);
  });

  it("keeps a live successor intact with delayed reaper A, owner B, and contender C", async () => {
    const deadPath = await seedClaim(target, {
      pid: 2 ** 30,
      host: hostname(),
      ownerToken: "abandoned-owner",
      ticket: 1,
    });
    const past = new Date(Date.now() - 60_000);
    await utimes(deadPath, past, past);

    const startPath = join(dir, "contenders-start");
    const resumeAPath = join(dir, "resume-reaper-a");
    const eventDirectory = join(dir, "critical-events");
    const criticalGuard = join(dir, "critical-section.guard");
    const childA = spawnReaperChild(
      "a",
      target,
      startPath,
      100,
      eventDirectory,
      criticalGuard,
      resumeAPath,
    );
    children.push(childA);
    const outputA = observeChild(childA);
    await waitFor(async () => outputA.lines.includes("READY:a"), 5_000);
    await writeFile(startPath, "start\n", "utf-8");
    await waitFor(async () => outputA.lines.includes("SNAPSHOT:a"), 5_000);

    const childB = spawnReaperChild("b", target, startPath, 1_200, eventDirectory, criticalGuard);
    children.push(childB);
    const outputB = observeChild(childB);
    await waitFor(async () => existsSync(join(eventDirectory, "entered-b")), 5_000);
    const liveBClaim = await findClaimForPid(target, childB.pid!);

    const childC = spawnReaperChild("c", target, startPath, 100, eventDirectory, criticalGuard);
    children.push(childC);
    const outputC = observeChild(childC);
    await writeFile(resumeAPath, "resume\n", "utf-8");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect((await readdir(eventDirectory)).filter((name) => name.startsWith("entered-")))
      .toEqual(["entered-b"]);
    expect(existsSync(deadPath)).toBe(false);
    expect(existsSync(liveBClaim)).toBe(true);
    await waitFor(async () => outputC.lines.includes("READY:c"), 5_000);

    const childBExit = await waitForChildExit(
      childB,
      `b stdout=${outputB.lines.join("|")} stderr=${outputB.stderr.join("|")}`,
    );
    expect({ code: childBExit, stderr: outputB.stderr }).toEqual({ code: 0, stderr: [] });
    const childAExit = await waitForChildExit(
      childA,
      `a stdout=${outputA.lines.join("|")} stderr=${outputA.stderr.join("|")}`,
    );
    const childCExit = await waitForChildExit(
      childC,
      `c stdout=${outputC.lines.join("|")} stderr=${outputC.stderr.join("|")}`,
    );
    expect({ code: childAExit, stderr: outputA.stderr }).toEqual({ code: 0, stderr: [] });
    expect({ code: childCExit, stderr: outputC.stderr }).toEqual({ code: 0, stderr: [] });

    expect((await readdir(eventDirectory)).sort()).toEqual([
      "entered-a",
      "entered-b",
      "entered-c",
      "released-a",
      "released-b",
      "released-c",
    ]);
    expect(existsSync(criticalGuard)).toBe(false);
    expect(await claimNames(target)).toEqual([]);
  }, 20_000);

  it("throws FileLockTimeoutError while a foreign claim remains authoritative", async () => {
    const claimPath = await seedClaim(target, {
      pid: 2 ** 30,
      host: "foreign-host.example",
      ownerToken: "foreign-timeout-owner",
      ticket: 1,
    });

    await expect(withFileLock(
      target,
      async () => "unreachable",
      { timeoutMs: 150, pollMs: 10, staleMs: 20 },
    )).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect((await stat(claimPath)).isFile()).toBe(true);
  });
});

function lockDirectory(target: string): string {
  return `${target}.lock`;
}

async function claimNames(target: string): Promise<string[]> {
  return (await readdir(lockDirectory(target)))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

async function seedClaim(
  target: string,
  input: Pick<ClaimRecord, "pid" | "host" | "ownerToken" | "ticket">,
): Promise<string> {
  const directory = lockDirectory(target);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${input.ownerToken}.json`);
  const record: ClaimRecord = {
    version: 2,
    pid: input.pid,
    host: input.host,
    acquiredAt: new Date().toISOString(),
    ownerToken: input.ownerToken,
    choosing: false,
    ticket: input.ticket,
  };
  await writeFile(path, `${JSON.stringify(record)}\n`, "utf-8");
  return path;
}

async function findClaimForPid(target: string, pid: number): Promise<string> {
  let match: string | null = null;
  await waitFor(async () => {
    for (const name of await claimNames(target)) {
      const path = join(lockDirectory(target), name);
      const claim = JSON.parse(await readFile(path, "utf-8")) as ClaimRecord;
      if (claim.pid === pid) {
        match = path;
        return true;
      }
    }
    return false;
  }, 5_000);
  return match!;
}

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
  holdMs: number,
  eventDirectory: string,
  criticalGuard: string,
  snapshotReleasePath?: string,
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
      MEMORY_TEST_REAPER_HOLD_MS: String(holdMs),
      MEMORY_TEST_REAPER_EVENT_DIR: eventDirectory,
      MEMORY_TEST_REAPER_CRITICAL_GUARD: criticalGuard,
      ...(snapshotReleasePath ? { MEMORY_TEST_REAPER_SNAPSHOT_RELEASE: snapshotReleasePath } : {}),
    },
    windowsHide: true,
  });
}

function observeChild(child: ChildProcessWithoutNullStreams): { lines: string[]; stderr: string[] } {
  const lines: string[] = [];
  const stderr: string[] = [];
  let pending = "";
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf-8");
    const complete = pending.split(/\r?\n/u);
    pending = complete.pop() ?? "";
    lines.push(...complete.filter((line) => line.length > 0));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(...chunk.toString("utf-8").split(/\r?\n/u).filter((line) => line.length > 0));
  });
  return { lines, stderr };
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

function waitForChildExit(child: ChildProcessWithoutNullStreams, context = ""): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`timed out waiting for child exit${context ? `: ${context}` : ""}`));
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
