import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
}

interface FileLockOwner {
  pid: number;
  host: string;
  acquiredAt: string;
  ownerToken: string;
}

interface FileLockSnapshot {
  raw: string;
  pid?: unknown;
  host?: unknown;
  ownerToken?: unknown;
}

export class FileLockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`could not acquire ${lockPath} within ${timeoutMs}ms (held by another process)`);
    this.name = "FileLockTimeoutError";
  }
}

export async function withFileLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const pollMs = opts.pollMs ?? 100;
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  const owner: FileLockOwner = {
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    ownerToken: randomUUID(),
  };

  await mkdir(dirname(lockPath), { recursive: true });
  while (!(await tryAcquire(lockPath, owner))) {
    await breakIfStale(lockPath, staleMs);
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, timeoutMs);
    await sleep(pollMs);
  }

  const stopHeartbeat = startOwnedHeartbeat(lockPath, owner.ownerToken, staleMs, opts.heartbeatMs);
  try {
    return await operation();
  } finally {
    await stopHeartbeat();
    await unlinkIfOwned(lockPath, owner.ownerToken);
  }
}

async function tryAcquire(lockPath: string, owner: FileLockOwner): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(owner), "utf-8");
    } finally {
      await handle.close();
      handle = null;
    }
    return true;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    // EEXIST: lock held (POSIX + Windows). EPERM/EACCES: Windows returns these
    // from an exclusive "wx" open while the lock file is in delete-pending state
    // (another process's handle is still closing) — contention, not failure.
    if (isLockContentionError(error)) return false;
    throw error;
  }
}

/**
 * True for the errno codes an exclusive lock-file open raises under contention:
 * EEXIST everywhere, plus EPERM/EACCES on Windows during a delete-pending race.
 */
export function isLockContentionError(error: unknown): boolean {
  return isCode(error, "EEXIST") || isCode(error, "EPERM") || isCode(error, "EACCES");
}

async function breakIfStale(lockPath: string, staleMs: number): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= staleMs) return;
    const snapshot = await readLockSnapshot(lockPath);
    if (!snapshot || !(await isSameHostHolderConfirmedDead(snapshot))) return;
    await unlinkIfSnapshotMatches(lockPath, snapshot);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

async function readLockSnapshot(lockPath: string): Promise<FileLockSnapshot | null> {
  try {
    const raw = await readFile(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as { pid?: unknown; host?: unknown; ownerToken?: unknown };
    return { raw, pid: parsed.pid, host: parsed.host, ownerToken: parsed.ownerToken };
  } catch {
    return null;
  }
}

async function isSameHostHolderConfirmedDead(snapshot: FileLockSnapshot): Promise<boolean> {
  if (snapshot.host !== hostname()) return false;
  if (typeof snapshot.pid !== "number" || !Number.isInteger(snapshot.pid) || snapshot.pid <= 0) return false;
  try {
    process.kill(snapshot.pid, 0);
    return false;
  } catch (error) {
    return isCode(error, "ESRCH");
  }
}

async function unlinkIfSnapshotMatches(lockPath: string, expected: FileLockSnapshot): Promise<void> {
  const current = await readLockSnapshot(lockPath);
  if (!current) return;
  const expectedToken = typeof expected.ownerToken === "string" ? expected.ownerToken : null;
  const currentToken = typeof current.ownerToken === "string" ? current.ownerToken : null;
  const matches = expectedToken !== null
    ? currentToken === expectedToken
    : currentToken === null && current.raw === expected.raw;
  if (!matches) return;
  await unlink(lockPath).catch((error) => {
    if (!isCode(error, "ENOENT")) throw error;
  });
}

async function unlinkIfOwned(lockPath: string, ownerToken: string): Promise<void> {
  const snapshot = await readLockSnapshot(lockPath);
  if (!snapshot || snapshot.ownerToken !== ownerToken) return;
  await unlink(lockPath).catch((error) => {
    if (!isCode(error, "ENOENT")) throw error;
  });
}

function startOwnedHeartbeat(
  lockPath: string,
  ownerToken: string,
  staleMs: number,
  requestedHeartbeatMs?: number,
): () => Promise<void> {
  const safeCeiling = Math.max(1, Math.floor(staleMs / 2));
  const intervalMs = Math.max(
    1,
    Math.min(requestedHeartbeatMs ?? Math.max(1, Math.floor(staleMs / 3)), safeCeiling),
  );
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = Promise.resolve();
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = refreshOwnedLock(lockPath, ownerToken)
        .then((stillOwner) => {
          if (stillOwner) schedule();
        })
        .catch(() => undefined);
    }, intervalMs);
  };
  schedule();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
  };
}

async function refreshOwnedLock(lockPath: string, ownerToken: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, "r+");
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
  try {
    const parsed = JSON.parse(await handle.readFile("utf-8")) as { ownerToken?: unknown };
    if (parsed.ownerToken !== ownerToken) return false;
    const now = new Date();
    await handle.utimes(now, now);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
