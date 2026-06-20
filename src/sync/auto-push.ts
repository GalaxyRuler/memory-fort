import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn as realSpawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../storage/atomic-write.js";
import { memoryRoot as defaultMemoryRoot } from "../storage/paths.js";

export interface AutoPushOptions {
  memoryRoot?: string;
  debounceMs?: number;
  workerPath?: string;
  spawnFn?: typeof realSpawn;
  now?: () => Date;
}

export type ScheduleResult =
  | { scheduled: true; token: string; workerPid?: number }
  | { scheduled: false; reason: "disabled" | "busy" };

export interface PendingFile {
  token: string;
  scheduledAt: string;
  debounceMs: number;
}

export async function scheduleAutoPush(opts: AutoPushOptions = {}): Promise<ScheduleResult> {
  if (process.env["MEMORY_AUTO_PUSH"] === "0") {
    return { scheduled: false, reason: "disabled" };
  }

  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const debounceMs = opts.debounceMs ?? 5000;
  const nowFn = opts.now ?? (() => new Date());
  const token = randomBytes(8).toString("hex");
  const workerPath = opts.workerPath ?? defaultWorkerPath();
  const spawnFn = opts.spawnFn ?? realSpawn;

  await ensureAutoPushIgnored(root);
  const scheduledAt = nowFn().toISOString();
  const wrotePending = await writePendingFile(root, {
    token,
    scheduledAt,
    debounceMs,
  });
  if (!wrotePending) return { scheduled: false, reason: "busy" };

  const child = spawnFn("node", [workerPath, root, token], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  await writeLastScheduledFile(root, scheduledAt);
  return { scheduled: true, token, workerPid: child.pid };
}

export async function readPendingFile(memoryRoot: string): Promise<PendingFile | null> {
  const path = pendingPath(memoryRoot);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<PendingFile>;
  if (typeof parsed.token !== "string" || typeof parsed.scheduledAt !== "string") return null;
  return {
    token: parsed.token,
    scheduledAt: parsed.scheduledAt,
    debounceMs: typeof parsed.debounceMs === "number" ? parsed.debounceMs : 5000,
  };
}

export async function writePendingFile(memoryRoot: string, contents: PendingFile): Promise<boolean> {
  const path = pendingPath(memoryRoot);
  await mkdir(dirname(path), { recursive: true });
  const releaseLock = tryAcquirePendingFileLock(`${path}.lock`);
  if (!releaseLock) return false;

  try {
    await atomicWrite(path, `${JSON.stringify(contents, null, 2)}\n`);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  } finally {
    releaseLock();
  }
}

export async function deletePendingFile(memoryRoot: string): Promise<void> {
  try {
    await unlink(pendingPath(memoryRoot));
  } catch {
    // Missing pending file is fine; a newer worker may have already removed it.
  }
}

function pendingPath(memoryRoot: string): string {
  return join(memoryRoot, ".auto-push-pending");
}

async function writeLastScheduledFile(memoryRoot: string, scheduledAt: string): Promise<void> {
  await writeFile(join(memoryRoot, ".auto-push-last-scheduled"), `${scheduledAt}\n`, "utf-8");
}

function tryAcquirePendingFileLock(path: string): (() => void) | null {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (err) {
    if (isBusyPendingFileLockError(err, path)) return null;
    throw err;
  }

  return () => {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // Another process may have cleaned up a stale lock; the pending write is done.
    }
  };
}

export function isBusyPendingFileLockError(error: unknown, _lockPath: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  // EEXIST: lock held by another process (POSIX + Windows).
  // EPERM/EACCES: Windows returns these from an exclusive "wx" open when the
  // lock is in delete-pending state (a handle is still closing). existsSync()
  // reports false for such a file, so gating on existence misclassified this
  // transient contention as a fatal error and threw "auto-push schedule
  // failed". Treat it as busy and let the next scheduled run retry.
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}

async function ensureAutoPushIgnored(memoryRoot: string): Promise<void> {
  const excludePath = join(memoryRoot, ".git", "info", "exclude");
  if (!existsSync(join(memoryRoot, ".git"))) return;

  await mkdir(dirname(excludePath), { recursive: true });
  const current = existsSync(excludePath) ? await readFile(excludePath, "utf-8") : "";
  const lines = current.split(/\r?\n/);
  const missing = [
    ".auto-push-pending",
    ".auto-push-pending.lock",
    ".auto-push-pending.*.tmp",
    ".auto-push-last-scheduled",
    "auto-sync.log",
  ].filter((line) => !lines.includes(line));
  if (missing.length === 0) return;

  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await appendFile(excludePath, `${prefix}${missing.join("\n")}\n`, "utf-8");
}

function defaultWorkerPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "auto-push-worker.mjs");
}
