import { open, readFile, stat, unlink, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
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

  await mkdir(dirname(lockPath), { recursive: true });
  while (!(await tryAcquire(lockPath))) {
    await breakIfStale(lockPath, staleMs);
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, timeoutMs);
    await sleep(pollMs);
  }

  try {
    return await operation();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

async function tryAcquire(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          host: hostname(),
          acquiredAt: new Date().toISOString(),
        }),
        "utf-8",
      );
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  }
}

async function breakIfStale(lockPath: string, staleMs: number): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= staleMs) return;
    if (await isHolderDead(lockPath)) {
      await unlink(lockPath).catch(() => undefined);
    }
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

async function isHolderDead(lockPath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf-8")) as {
      pid?: unknown;
      host?: unknown;
    };
    if (typeof parsed.pid !== "number") return true;
    if (typeof parsed.host === "string" && parsed.host !== hostname()) return true;
    try {
      process.kill(parsed.pid, 0);
      return false;
    } catch (error) {
      if (isCode(error, "EPERM")) return false;
      return true;
    }
  } catch {
    return true;
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
