import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { atomicAppend } from "../storage/atomic-write.js";
import { memoryRoot as defaultMemoryRoot } from "../storage/paths.js";
import { scheduleAutoPush, type ScheduleResult } from "./auto-push.js";
import { makeRealCommandRunner, type CommandRunner } from "./git-remote.js";

export interface CommitVaultChangeOptions {
  paths: string[];
  message: string;
  memoryRoot?: string;
  runner?: CommandRunner;
  scheduleAutoPush?: (opts: { memoryRoot?: string }) => Promise<ScheduleResult>;
  now?: () => Date;
}

export type CommitVaultChangeResult =
  | { kind: "no-changes" }
  | { kind: "committed"; commitSha: string }
  | { kind: "failed"; error: string };

export async function commitVaultChange(
  opts: CommitVaultChangeOptions,
): Promise<CommitVaultChangeResult> {
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const runner = opts.runner ?? makeRealCommandRunner();
  const paths = uniqueNormalizedPaths(root, opts.paths);
  if (paths.length === 0) return { kind: "no-changes" };

  try {
    const status = await runner.run("git", ["status", "--porcelain", "--", ...paths], { cwd: root });
    if (status.exitCode !== 0) {
      return await commitFailure(root, opts.message, `git status failed: ${commandOutput(status)}`, opts.now);
    }
    if (status.stdout.trim().length === 0) return { kind: "no-changes" };

    const add = await runner.run("git", ["add", "--", ...paths], { cwd: root });
    if (add.exitCode !== 0) {
      return await commitFailure(root, opts.message, `git add failed: ${commandOutput(add)}`, opts.now);
    }

    const commit = await runner.run("git", ["commit", "-m", opts.message], { cwd: root });
    if (commit.exitCode !== 0) {
      return await commitFailure(root, opts.message, `git commit failed: ${commandOutput(commit)}`, opts.now);
    }

    const schedule = opts.scheduleAutoPush ?? scheduleAutoPush;
    try {
      await schedule({ memoryRoot: root });
    } catch (error) {
      await logCommitError(root, opts.message, `auto-push schedule failed: ${errorMessage(error)}`, opts.now);
    }

    return {
      kind: "committed",
      commitSha: parseCommitSha(commit.stdout) ?? parseCommitSha(commit.stderr) ?? "",
    };
  } catch (error) {
    return await commitFailure(root, opts.message, errorMessage(error), opts.now);
  }
}

function uniqueNormalizedPaths(memoryRoot: string, paths: string[]): string[] {
  const root = resolve(memoryRoot);
  const normalized = paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => {
      const resolved = resolve(root, path);
      const rel = relative(root, resolved).replace(/\\/g, "/");
      return rel.length === 0 || rel.startsWith("../") || rel === ".." ? "" : rel;
    })
    .filter((path) => path.length > 0);
  return [...new Set(normalized)];
}

async function commitFailure(
  memoryRoot: string,
  message: string,
  error: string,
  now?: () => Date,
): Promise<CommitVaultChangeResult> {
  await logCommitError(memoryRoot, message, error, now);
  return { kind: "failed", error };
}

async function logCommitError(
  memoryRoot: string,
  message: string,
  error: string,
  now?: () => Date,
): Promise<void> {
  try {
    const errorsPath = join(memoryRoot, "errors.log");
    if (!existsSync(dirname(errorsPath))) {
      await mkdir(dirname(errorsPath), { recursive: true });
    }
    await atomicAppend(
      errorsPath,
      `[${(now ?? (() => new Date()))().toISOString()}] commit-vault-change failed | ${message} | ${error}\n`,
    );
  } catch {
    // Commit is best-effort; logging must not break the parent vault mutation.
  }
}

function commandOutput(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || "unknown error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function parseCommitSha(output: string): string | null {
  return /\[[^\s\]]+\s+([a-f0-9]+)\]/i.exec(output)?.[1] ?? null;
}
