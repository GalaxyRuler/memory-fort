import { join } from "node:path";
import { atomicAppend } from "../storage/atomic-write.js";
import { runSync, type SyncResult } from "../cli/commands/sync.js";
import { autoCommitRawsIfDirty, type AutoCommitResult } from "./auto-commit-raws.js";
import { makeRealCommandRunner } from "./git-remote.js";
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
  autoCommitFn?: () => Promise<AutoCommitResult>;
  syncFn?: () => Promise<Partial<SyncResult>>;
  logSink?: (line: string) => Promise<void>;
  now?: () => Date;
}

export interface WorkerResult {
  outcome: "pushed" | "stale-token" | "no-pending-file" | "offline" | "conflict";
  details?: string;
}

type AutoCommitDisposition =
  | "clean"
  | "committed"
  | { kind: "skipped"; reason: string };

export async function runAutoPushWorker(opts: WorkerOptions): Promise<WorkerResult> {
  const nowFn = opts.now ?? (() => new Date());
  const pending = await readPendingFile(opts.memoryRoot);
  if (!pending) return { outcome: "no-pending-file" };

  const sleepFn = opts.sleepFn ?? sleep;
  await sleepFn(pending.debounceMs);

  const latest = await readPendingFile(opts.memoryRoot);
  if (!latest) return { outcome: "no-pending-file" };
  if (latest.token !== opts.myToken) return { outcome: "stale-token" };

  const autoCommitFn = opts.autoCommitFn ??
    (opts.syncFn
      ? async () => ({ kind: "no-dirty-files" as const })
      : () => autoCommitRawsIfDirty({ memoryRoot: opts.memoryRoot, runner: makeRealCommandRunner(), now: nowFn }));
  const initialAutoCommit = await handleAutoCommit(opts.memoryRoot, autoCommitFn, nowFn, opts.logSink);
  if (isSkippedAutoCommit(initialAutoCommit)) return { outcome: "offline", details: initialAutoCommit.reason };

  const syncFn = opts.syncFn ?? (() => runSync({ memoryRoot: opts.memoryRoot }));
  try {
    const result = await syncAfterRawCommits(opts.memoryRoot, syncFn, autoCommitFn, nowFn, opts.logSink);

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
    if (err instanceof AutoPushSkipError) {
      return { outcome: "offline", details: err.message };
    }

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

async function syncAfterRawCommits(
  memoryRoot: string,
  syncFn: () => Promise<Partial<SyncResult>>,
  autoCommitFn: () => Promise<AutoCommitResult>,
  nowFn: () => Date,
  logSink?: (line: string) => Promise<void>,
): Promise<Partial<SyncResult>> {
  let lastDirtyError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await syncFn();
    } catch (err) {
      const e = err as Error & { exitCode?: number };
      if (e.exitCode !== 2) throw err;
      lastDirtyError = err;

      const retryAutoCommit = await handleAutoCommit(memoryRoot, autoCommitFn, nowFn, logSink);
      if (isSkippedAutoCommit(retryAutoCommit)) {
        throw new AutoPushSkipError(retryAutoCommit.reason);
      }
      if (retryAutoCommit !== "committed") throw err;
    }
  }
  throw lastDirtyError;
}

class AutoPushSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoPushSkipError";
  }
}

async function handleAutoCommit(
  memoryRoot: string,
  autoCommitFn: () => Promise<AutoCommitResult>,
  nowFn: () => Date,
  logSink?: (line: string) => Promise<void>,
): Promise<AutoCommitDisposition> {
  const autoCommit = await autoCommitFn();
  const nowIso = nowFn().toISOString();
  switch (autoCommit.kind) {
    case "no-dirty-files":
      return "clean";
    case "committed":
      await writeLog(
        memoryRoot,
        `[${nowIso}] auto-committed ${autoCommit.filesCount} vault system file(s) as ${autoCommit.commitSha.slice(0, 7)}\n`,
        logSink,
      );
      return "committed";
    case "skipped-non-raw-dirty": {
      const shown = autoCommit.dirtyNonRawFiles.slice(0, 3).join(", ");
      const suffix = autoCommit.dirtyNonRawFiles.length > 3 ? "..." : "";
      await writeLog(
        memoryRoot,
        `[${nowIso}] auto-push skipped: non-raw dirty files present (run \`memory sync\` after committing: ${shown}${suffix})\n`,
        logSink,
      );
      return { kind: "skipped", reason: "non-raw dirty tree" };
    }
    case "skipped-secret-shape": {
      const shown = autoCommit.secretFiles.slice(0, 3).join(", ");
      const suffix = autoCommit.secretFiles.length > 3 ? "..." : "";
      await writeLog(
        memoryRoot,
        `[${nowIso}] auto-push skipped: secret-shaped auto-commit file(s) require manual redaction before commit (${shown}${suffix})\n`,
        logSink,
      );
      return { kind: "skipped", reason: "secret-shaped auto-commit files" };
    }
  }
}

function isSkippedAutoCommit(disposition: AutoCommitDisposition): disposition is { kind: "skipped"; reason: string } {
  return typeof disposition === "object" && disposition.kind === "skipped";
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
