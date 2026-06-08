import { randomUUID } from "node:crypto";
import { open, rename, mkdir, appendFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

const WINDOWS_RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);
const WINDOWS_RENAME_RETRY_DELAYS_MS = [50, 150, 400] as const;

export interface AtomicWriteRetryStats {
  writes: number;
  success: number;
  exhausted: number;
}

export const atomicWriteRetryStats: AtomicWriteRetryStats = {
  writes: 0,
  success: 0,
  exhausted: 0,
};

/**
 * Atomic overwrite via .tmp + rename. Survives mid-write
 * crashes — the target file is either the old content or the
 * new content, never partial.
 *
 * Creates parent directories as needed.
 */
export async function atomicWrite(
  absolutePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  const tmp = `${absolutePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  atomicWriteRetryStats.writes += 1;
  await renameWithWindowsRetry(tmp, absolutePath);
  await syncParentDir(absolutePath);
}

/**
 * Best-effort durability: fsync the parent directory after the rename so the
 * new directory entry survives a crash on POSIX filesystems. Directory fsync
 * is unsupported on Windows (a directory handle cannot be opened for sync), so
 * skip it there. Never throws — durability hardening must not break the write
 * (some filesystems also disallow directory fsync).
 */
async function syncParentDir(absolutePath: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(dirname(absolutePath), "r");
    await handle.sync();
  } catch {
    // Directory fsync is best-effort; ignore unsupported / permission errors.
  } finally {
    await handle?.close();
  }
}

/**
 * Append to a file. Creates the file (and parent dirs) if
 * missing. Append is atomic for typical hook payload sizes
 * (≤ few KB) on Windows + POSIX.
 */
export async function atomicAppend(
  absolutePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  await appendFile(absolutePath, content, "utf-8");
}

async function renameWithWindowsRetry(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if (process.platform !== "win32" || !isRetriableWindowsRenameError(error)) {
      throw error;
    }
    await retryWindowsRename(from, to, error);
  }
}

async function retryWindowsRename(from: string, to: string, originalError: unknown): Promise<void> {
  for (const delayMs of WINDOWS_RENAME_RETRY_DELAYS_MS) {
    await sleep(delayMs);
    try {
      await rename(from, to);
      atomicWriteRetryStats.success += 1;
      return;
    } catch (error) {
      if (!isRetriableWindowsRenameError(error)) throw originalError;
    }
  }
  atomicWriteRetryStats.exhausted += 1;
  throw originalError;
}

function isRetriableWindowsRenameError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && WINDOWS_RENAME_RETRY_CODES.has(error.code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
