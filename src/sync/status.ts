import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";
import { withFileLock } from "../storage/file-lock.js";
import type { CommandRunner } from "./git-remote.js";

export type SyncState =
  | "clean"
  | "dirty"
  | "local-ahead"
  | "remote-ahead"
  | "divergent"
  | "conflicted";

export interface SyncStateFile {
  last_sync_attempt: string | null;
  last_sync_success: string | null;
  pending_push_count: number;
  conflicts_pending: number;
  conflict_files: string[];
}

export interface StatusContext {
  memoryRoot: string;
  remoteName: string;
  branch: string;
  runner: CommandRunner;
  now?: Date;
}

export async function defaultSyncStateFile(): Promise<SyncStateFile> {
  return {
    last_sync_attempt: null,
    last_sync_success: null,
    pending_push_count: 0,
    conflicts_pending: 0,
    conflict_files: [],
  };
}

export async function readSyncStateFile(memoryRoot: string): Promise<SyncStateFile> {
  const path = syncStatePath(memoryRoot);
  if (!existsSync(path)) return defaultSyncStateFile();
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<SyncStateFile>;
    const defaults = await defaultSyncStateFile();
    return {
      last_sync_attempt: typeof parsed.last_sync_attempt === "string" ? parsed.last_sync_attempt : defaults.last_sync_attempt,
      last_sync_success: typeof parsed.last_sync_success === "string" ? parsed.last_sync_success : defaults.last_sync_success,
      pending_push_count: typeof parsed.pending_push_count === "number" ? parsed.pending_push_count : defaults.pending_push_count,
      conflicts_pending: typeof parsed.conflicts_pending === "number" ? parsed.conflicts_pending : defaults.conflicts_pending,
      conflict_files: Array.isArray(parsed.conflict_files)
        ? parsed.conflict_files.filter((v): v is string => typeof v === "string")
        : defaults.conflict_files,
    };
  } catch {
    return defaultSyncStateFile();
  }
}

export async function writeSyncStateFile(memoryRoot: string, state: SyncStateFile): Promise<void> {
  await atomicWrite(syncStatePath(memoryRoot), `${JSON.stringify(state, null, 2)}\n`);
}

export async function mutateSyncStateFile(
  memoryRoot: string,
  mutator: (state: SyncStateFile) => SyncStateFile | Promise<SyncStateFile>,
): Promise<SyncStateFile> {
  return withFileLock(syncStatePath(memoryRoot), async () => {
    const state = await readSyncStateFile(memoryRoot);
    const next = await mutator(state);
    await writeSyncStateFile(memoryRoot, next);
    return next;
  });
}

export async function getSyncStatus(ctx: StatusContext): Promise<{
  state: SyncState;
  localAhead: number;
  remoteAhead: number;
  dirtyFiles: string[];
  syncStateFile: SyncStateFile;
}> {
  let syncStateFile = await readSyncStateFile(ctx.memoryRoot);
  if (syncStateFile.conflicts_pending > 0) {
    const unmerged = await ctx.runner.run("git", ["ls-files", "-u"], { cwd: ctx.memoryRoot });
    const conflictGone = unmerged.exitCode === 0 && unmerged.stdout.trim().length === 0;
    if (!conflictGone) {
      return {
        state: "conflicted",
        localAhead: 0,
        remoteAhead: 0,
        dirtyFiles: [],
        syncStateFile,
      };
    }
    syncStateFile = await mutateSyncStateFile(ctx.memoryRoot, (state) => ({
      ...state,
      conflicts_pending: 0,
      conflict_files: [],
    }));
  }

  const dirtyResult = await ctx.runner.run("git", ["status", "--porcelain"], { cwd: ctx.memoryRoot });
  if (dirtyResult.exitCode !== 0) {
    throw new Error(`git status failed: ${dirtyResult.stderr.trim() || dirtyResult.stdout.trim()}`);
  }
  const dirtyFiles = parseDirtyFiles(dirtyResult.stdout);
  if (dirtyFiles.length > 0) {
    return {
      state: "dirty",
      localAhead: 0,
      remoteAhead: 0,
      dirtyFiles,
      syncStateFile,
    };
  }

  const countResult = await ctx.runner.run(
    "git",
    ["rev-list", "--left-right", "--count", `HEAD...${ctx.remoteName}/${ctx.branch}`],
    { cwd: ctx.memoryRoot },
  );
  if (countResult.exitCode !== 0) {
    throw new Error(`git rev-list failed: ${countResult.stderr.trim() || countResult.stdout.trim()}`);
  }
  const [localAhead, remoteAhead] = countResult.stdout.trim().split(/\s+/).map((v) => Number(v));
  const state = classifyCounts(localAhead ?? 0, remoteAhead ?? 0);
  return {
    state,
    localAhead: localAhead ?? 0,
    remoteAhead: remoteAhead ?? 0,
    dirtyFiles,
    syncStateFile,
  };
}

function syncStatePath(memoryRoot: string): string {
  return join(memoryRoot, ".sync-state.json");
}

function classifyCounts(localAhead: number, remoteAhead: number): SyncState {
  if (localAhead > 0 && remoteAhead > 0) return "divergent";
  if (localAhead > 0) return "local-ahead";
  if (remoteAhead > 0) return "remote-ahead";
  return "clean";
}

function parseDirtyFiles(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^([ MADRCU?!]{1,2})\s+/, ""))
    .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1)! : line);
}
