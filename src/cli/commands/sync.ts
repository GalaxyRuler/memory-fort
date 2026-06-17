import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicAppend } from "../../storage/atomic-write.js";
import { memoryRoot as defaultMemoryRoot } from "../../storage/paths.js";
import { makeRealCommandRunner, type CommandRunner } from "../../sync/git-remote.js";
import {
  getSyncStatus,
  writeSyncStateFile,
  type SyncState,
  type SyncStateFile,
} from "../../sync/status.js";
import { loadMemoryConfig } from "../../storage/config.js";

export interface SyncOptions {
  memoryRoot?: string;
  remoteName?: string;
  branch?: string;
  runner?: CommandRunner;
  now?: Date;
}

export interface SyncResult {
  initialState: SyncState;
  finalState: SyncState;
  actionsPerformed: string[];
  retried: boolean;
  conflictFiles: string[];
  syncStateFile: SyncStateFile;
  remoteName: string;
  branch: string;
}

type SyncMode = "sync" | "pull" | "push";

export class SyncCommandError extends Error {
  exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "SyncCommandError";
    this.exitCode = exitCode;
  }
}

export async function runSync(opts: SyncOptions = {}): Promise<SyncResult> {
  return runSyncMode("sync", opts);
}

export async function runSyncMode(mode: SyncMode, opts: SyncOptions = {}): Promise<SyncResult> {
  const memoryRoot = opts.memoryRoot ?? defaultMemoryRoot();
  const remoteName = opts.remoteName ?? await resolveConfiguredRemoteName(memoryRoot);
  const branch = opts.branch ?? "main";
  const runner = opts.runner ?? makeRealCommandRunner();
  const now = opts.now ?? new Date();
  const ctx = { memoryRoot, remoteName, branch, runner, now };
  const attemptIso = now.toISOString();

  await ensureSyncStateIgnored(memoryRoot);

  let initialStatus = await getSyncStatus(ctx);
  throwIfConflicted(memoryRoot, initialStatus);
  if (initialStatus.state === "dirty") {
    throw new SyncCommandError(formatDirtyMessage(initialStatus.dirtyFiles), 2);
  }
  await gitChecked(runner, memoryRoot, ["fetch", remoteName, branch], "git fetch");
  initialStatus = await getSyncStatus(ctx);
  throwIfConflicted(memoryRoot, initialStatus);
  if (initialStatus.state === "dirty") {
    throw new SyncCommandError(formatDirtyMessage(initialStatus.dirtyFiles), 2);
  }

  const actionsPerformed: string[] = [];
  let retried = false;
  let finalState: SyncState = "clean";
  let pendingPushCount = 0;

  try {
    if (mode === "sync") {
      if (initialStatus.state === "local-ahead") {
        retried = await pushWithRetry(ctx, actionsPerformed);
      } else if (initialStatus.state === "remote-ahead") {
        await pullRebase(ctx, actionsPerformed);
      } else if (initialStatus.state === "divergent") {
        await pullRebase(ctx, actionsPerformed);
        retried = await pushWithRetry(ctx, actionsPerformed);
      }
    } else if (mode === "pull") {
      if (initialStatus.state === "remote-ahead" || initialStatus.state === "divergent") {
        await pullRebase(ctx, actionsPerformed);
      }
      if (initialStatus.state === "divergent" || initialStatus.state === "local-ahead") {
        pendingPushCount = initialStatus.localAhead;
        finalState = "local-ahead";
      }
    } else {
      if (initialStatus.localAhead > 0) {
        const pushed = await tryPush(ctx);
        if (pushed.rejected) {
          retried = true;
          await pullRebase(ctx, actionsPerformed);
          await pushStrict(ctx, actionsPerformed, "push");
        } else {
          actionsPerformed.push("push");
        }
      }
    }
  } catch (err) {
    if (err instanceof SyncCommandError) throw err;
    throw err;
  }

  if (actionsPerformed.includes("push")) pendingPushCount = 0;
  const nextStateFile = {
    last_sync_attempt: attemptIso,
    last_sync_success: attemptIso,
    pending_push_count: pendingPushCount,
    conflicts_pending: 0,
    conflict_files: [],
  };
  await writeSyncStateFile(memoryRoot, nextStateFile);

  return {
    initialState: initialStatus.state,
    finalState,
    actionsPerformed,
    retried,
    conflictFiles: [],
    syncStateFile: nextStateFile,
    remoteName,
    branch,
  };
}

async function resolveConfiguredRemoteName(memoryRoot: string): Promise<string> {
  const configured = (await loadMemoryConfig(memoryRoot)).sync?.remote_name?.trim();
  return configured && configured.length > 0 ? configured : "vps";
}

export function formatSyncSuccess(result: SyncResult, remoteName = result.remoteName, branch = result.branch): string {
  if (result.actionsPerformed.length === 0) return "Sync clean. No changes to push or pull.\n";
  if (result.retried) return "Push rejected; rebased and retried successfully.\n";
  if (result.actionsPerformed.join(",") === "push") return `Pushed local commits to ${remoteName}/${branch}.\n`;
  if (result.actionsPerformed.join(",") === "pull-rebase") return `Pulled remote commits from ${remoteName}/${branch}.\n`;
  if (result.actionsPerformed.join(",") === "pull-rebase,push") {
    return `Rebased onto remote commits; pushed local commits to ${remoteName}/${branch}.\n`;
  }
  return `Sync actions: ${result.actionsPerformed.join(", ")}.\n`;
}

async function pullRebase(ctx: RequiredContext, actionsPerformed: string[]): Promise<void> {
  const result = await ctx.runner.run("git", ["pull", "--rebase", ctx.remoteName, ctx.branch], { cwd: ctx.memoryRoot });
  if (result.exitCode === 0) {
    actionsPerformed.push("pull-rebase");
    return;
  }
  const conflictFiles = await getUnmergedFiles(ctx);
  if (conflictFiles.length > 0) {
    await ctx.runner.run("git", ["rebase", "--abort"], { cwd: ctx.memoryRoot });
    await markConflicted(ctx, conflictFiles);
    throw new SyncCommandError(formatConflictMessage(ctx.memoryRoot, conflictFiles), 3);
  }
  throw new Error(`git pull --rebase failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

async function pushWithRetry(ctx: RequiredContext, actionsPerformed: string[]): Promise<boolean> {
  const pushed = await tryPush(ctx);
  if (!pushed.rejected) {
    actionsPerformed.push("push");
    return false;
  }
  await pullRebase(ctx, actionsPerformed);
  await pushStrict(ctx, actionsPerformed, "push");
  return true;
}

async function tryPush(ctx: RequiredContext): Promise<{ rejected: boolean }> {
  const result = await ctx.runner.run("git", ["push", ctx.remoteName, ctx.branch], { cwd: ctx.memoryRoot });
  if (result.exitCode === 0) return { rejected: false };
  const output = `${result.stderr}\n${result.stdout}`;
  if (isPushReject(output)) return { rejected: true };
  throw new Error(`git push ${ctx.remoteName} ${ctx.branch} failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

async function pushStrict(ctx: RequiredContext, actionsPerformed: string[], actionName: string): Promise<void> {
  const result = await ctx.runner.run("git", ["push", ctx.remoteName, ctx.branch], { cwd: ctx.memoryRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git push ${ctx.remoteName} ${ctx.branch} failed after retry: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  actionsPerformed.push(actionName);
}

async function gitChecked(
  runner: CommandRunner,
  memoryRoot: string,
  args: string[],
  description: string,
): Promise<void> {
  const result = await runner.run("git", args, { cwd: memoryRoot });
  if (result.exitCode !== 0) {
    throw new Error(`${description} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

async function getUnmergedFiles(ctx: RequiredContext): Promise<string[]> {
  const result = await ctx.runner.run("git", ["status", "--porcelain=v2"], { cwd: ctx.memoryRoot });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("u "))
    .map((line) => line.trim().split(/\s+/).at(-1))
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

async function markConflicted(ctx: RequiredContext, conflictFiles: string[]): Promise<void> {
  const iso = ctx.now.toISOString();
  await writeSyncStateFile(ctx.memoryRoot, {
    last_sync_attempt: iso,
    last_sync_success: null,
    pending_push_count: 0,
    conflicts_pending: conflictFiles.length,
    conflict_files: conflictFiles,
  });
  await atomicAppend(
    join(ctx.memoryRoot, "errors.log"),
    `[${iso}] sync conflict | ${conflictFiles.length} files | ${conflictFiles.join(", ")}\n`,
  );
}

function formatDirtyMessage(dirtyFiles: string[]): string {
  return [
    "Sync paused: working tree has uncommitted changes.",
    "Dirty files:",
    ...dirtyFiles.map((file) => `  - ${file}`),
    "Commit or stash these changes, then re-run: memory sync",
  ].join("\n");
}

function formatConflictMessage(memoryRoot: string, conflictFiles: string[]): string {
  const first = conflictFiles[0] ?? "<file>";
  return [
    `Sync paused: ${conflictFiles.length} files have unresolved conflicts.`,
    "Conflict files:",
    ...conflictFiles.map((file) => `  - ${file}`),
    "To resolve:",
    "  1. Edit each file; remove conflict markers (<<<<<<<, =======, >>>>>>>); keep the content you want",
    `  2. Run: git -C ${memoryRoot} add <file>; git -C ${memoryRoot} commit -m "resolve conflict in ${first}"`,
    `  3. Clear the conflict state: edit ${join(memoryRoot, ".sync-state.json")} and set conflicts_pending: 0 and conflict_files: []`,
    "  4. Re-run: memory sync",
  ].join("\n");
}

function throwIfConflicted(
  memoryRoot: string,
  status: { state: SyncState; syncStateFile: SyncStateFile },
): void {
  if (status.state === "conflicted") {
    throw new SyncCommandError(
      formatConflictMessage(memoryRoot, status.syncStateFile.conflict_files),
      3,
    );
  }
}

function isPushReject(output: string): boolean {
  return /remote contains work|fetch first|non-fast-forward|rejected/i.test(output);
}

async function ensureSyncStateIgnored(memoryRoot: string): Promise<void> {
  const excludePath = join(memoryRoot, ".git", "info", "exclude");
  if (!existsSync(excludePath)) return;
  const content = await readFile(excludePath, "utf-8");
  if (content.split(/\r?\n/).includes(".sync-state.json")) return;
  await appendFile(excludePath, `${content.endsWith("\n") ? "" : "\n"}.sync-state.json\n`, "utf-8");
}

interface RequiredContext {
  memoryRoot: string;
  remoteName: string;
  branch: string;
  runner: CommandRunner;
  now: Date;
}
