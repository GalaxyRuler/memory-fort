import { join } from "node:path";
import { atomicAppend } from "../storage/atomic-write.js";
import { runSync, type SyncResult } from "../cli/commands/sync.js";
import {
  readSyncStateFile,
  writeSyncStateFile,
} from "./status.js";
import {
  deletePendingFile,
  readPendingFile,
} from "./auto-push.js";

export interface WorkerOptions {
  memoryRoot: string;
  myToken: string;
  sleepFn?: (ms: number) => Promise<void>;
  syncFn?: () => Promise<Partial<SyncResult>>;
  logSink?: (line: string) => Promise<void>;
  now?: () => Date;
}

export interface WorkerResult {
  outcome: "pushed" | "stale-token" | "no-pending-file" | "offline" | "conflict";
  details?: string;
}

export async function runAutoPushWorker(opts: WorkerOptions): Promise<WorkerResult> {
  const nowFn = opts.now ?? (() => new Date());
  const pending = await readPendingFile(opts.memoryRoot);
  if (!pending) return { outcome: "no-pending-file" };

  const sleepFn = opts.sleepFn ?? sleep;
  await sleepFn(pending.debounceMs);

  const latest = await readPendingFile(opts.memoryRoot);
  if (!latest) return { outcome: "no-pending-file" };
  if (latest.token !== opts.myToken) return { outcome: "stale-token" };

  const syncFn = opts.syncFn ?? (() => runSync({ memoryRoot: opts.memoryRoot }));
  try {
    const result = await syncFn();
    if (result.finalState === "conflicted") {
      const conflictFiles = result.conflictFiles ?? result.syncStateFile?.conflict_files ?? [];
      await markConflict(opts.memoryRoot, conflictFiles, nowFn, opts.logSink);
      await deletePendingFile(opts.memoryRoot);
      return { outcome: "conflict", details: `${conflictFiles.length} files` };
    }

    const pushedCommits = result.actionsPerformed?.includes("push") ? 1 : 0;
    await deletePendingFile(opts.memoryRoot);
    await updateSyncState(opts.memoryRoot, nowFn(), {
      last_sync_success: nowFn().toISOString(),
      pending_push_count: 0,
      conflicts_pending: 0,
      conflict_files: [],
    });
    await writeLog(opts.memoryRoot, `[${nowFn().toISOString()}] auto-push success | ${pushedCommits} commits\n`, opts.logSink);
    return { outcome: "pushed", details: `${pushedCommits} commits` };
  } catch (err) {
    const e = err as Error & { exitCode?: number; conflictFiles?: string[] };
    if (e.exitCode === 3) {
      const state = await readSyncStateFile(opts.memoryRoot);
      const conflictFiles = e.conflictFiles ?? state.conflict_files;
      await markConflict(opts.memoryRoot, conflictFiles, nowFn, opts.logSink);
      await deletePendingFile(opts.memoryRoot);
      return { outcome: "conflict", details: `${conflictFiles.length} files` };
    }

    await deletePendingFile(opts.memoryRoot);
    await updateSyncState(opts.memoryRoot, nowFn(), {
      pending_push_count: 1,
    });
    await writeLog(
      opts.memoryRoot,
      `[${nowFn().toISOString()}] auto-push failed | ${e.message ?? "unknown error"}\n`,
      opts.logSink,
    );
    return { outcome: "offline", details: e.message };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateSyncState(
  memoryRoot: string,
  now: Date,
  patch: Partial<Awaited<ReturnType<typeof readSyncStateFile>>>,
): Promise<void> {
  const current = await readSyncStateFile(memoryRoot);
  await writeSyncStateFile(memoryRoot, {
    ...current,
    ...patch,
    last_sync_attempt: now.toISOString(),
  });
}

async function markConflict(
  memoryRoot: string,
  conflictFiles: string[],
  nowFn: () => Date,
  logSink?: (line: string) => Promise<void>,
): Promise<void> {
  const iso = nowFn().toISOString();
  await writeSyncStateFile(memoryRoot, {
    last_sync_attempt: iso,
    last_sync_success: null,
    pending_push_count: 0,
    conflicts_pending: conflictFiles.length,
    conflict_files: conflictFiles,
  });
  await atomicAppend(
    join(memoryRoot, "errors.log"),
    `[${iso}] auto-push conflict | ${conflictFiles.length} files | ${conflictFiles.join(", ")}\n`,
  );
  await writeLog(memoryRoot, `[${iso}] auto-push conflict | ${conflictFiles.length} files\n`, logSink);
}

async function writeLog(
  memoryRoot: string,
  line: string,
  logSink?: (line: string) => Promise<void>,
): Promise<void> {
  if (logSink) {
    await logSink(line);
    return;
  }
  await atomicAppend(join(memoryRoot, "auto-sync.log"), line);
}

if (process.argv[1]?.endsWith("auto-push-worker.mjs")) {
  const [, , memoryRoot, token] = process.argv;
  if (memoryRoot && token) {
    runAutoPushWorker({ memoryRoot, myToken: token })
      .catch(async (err) => {
        try {
          await atomicAppend(
            join(memoryRoot, "auto-sync.log"),
            `[${new Date().toISOString()}] auto-push failed | ${(err as Error).message}\n`,
          );
        } catch {
          // Fire-and-forget worker: never surface failures to the host.
        }
      })
      .finally(() => process.exit(0));
  }
}
