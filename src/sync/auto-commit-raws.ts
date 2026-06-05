import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { containsSecretShape } from "../privacy/redaction.js";
import type { CommandRunner } from "./git-remote.js";

export interface AutoCommitOptions {
  memoryRoot: string;
  runner: CommandRunner;
  now?: () => Date;
}

export type AutoCommitResult =
  | { kind: "no-dirty-files" }
  | { kind: "committed"; filesCount: number; commitSha: string }
  | { kind: "skipped-non-raw-dirty"; dirtyNonRawFiles: string[] }
  | { kind: "skipped-secret-shape"; secretFiles: string[] };

interface DirtyFile {
  path: string;
  isAutoCommitEligible: boolean;
}

export async function autoCommitRawsIfDirty(opts: AutoCommitOptions): Promise<AutoCommitResult> {
  const status = await opts.runner.run("git", ["status", "--porcelain", "-uall"], { cwd: opts.memoryRoot });
  if (status.exitCode !== 0) {
    throw new Error(`git status --porcelain -uall failed: ${status.stderr.trim() || status.stdout.trim()}`);
  }

  const dirty = parseDirtyFiles(status.stdout);
  if (dirty.length === 0) return { kind: "no-dirty-files" };

  const blocked = dirty.filter((file) => !file.isAutoCommitEligible).map((file) => file.path);
  if (blocked.length > 0) {
    return { kind: "skipped-non-raw-dirty", dirtyNonRawFiles: blocked };
  }

  const files = [...new Set(dirty.map((file) => file.path))];
  const secretFiles = await findSecretFiles(opts.memoryRoot, files);
  if (secretFiles.length > 0) {
    return { kind: "skipped-secret-shape", secretFiles };
  }

  const message = `chore: auto-capture ${files.length} vault system file(s)`;
  const add = await opts.runner.run("git", ["add", "--", ...files], { cwd: opts.memoryRoot });
  if (add.exitCode !== 0) {
    throw new Error(`git add auto-commit files failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }
  const commit = await opts.runner.run("git", ["commit", "-m", message], { cwd: opts.memoryRoot });
  if (commit.exitCode !== 0) {
    throw new Error(`git commit auto-commit files failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }

  return {
    kind: "committed",
    filesCount: files.length,
    commitSha: parseCommitSha(commit.stdout) ?? parseCommitSha(commit.stderr) ?? "",
  };
}

function parseDirtyFiles(output: string): DirtyFile[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => parseStatusPath(line))
    .filter((path): path is string => path.length > 0)
    .map((path) => ({
      path,
      isAutoCommitEligible: isAutoCommitEligiblePath(path),
    }));
}

function isAutoCommitEligiblePath(path: string): boolean {
  return isRawPath(path) || isSystemManagedPath(path);
}

function isRawPath(path: string): boolean {
  return path === "raw" || path.startsWith("raw/");
}

function isSystemManagedPath(path: string): boolean {
  return path === "log.md"
    || path.startsWith("wiki/.audit/")
    || path === "embeddings/auto-heal.jsonl";
}

function parseStatusPath(line: string): string {
  const raw = line.slice(3).trim();
  const renamed = raw.includes(" -> ") ? raw.split(" -> ").at(-1)! : raw;
  return unquotePath(renamed).replace(/\\/g, "/");
}

function unquotePath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1);
  }
  return path;
}

function parseCommitSha(output: string): string | null {
  return /\[[^\s\]]+\s+([a-f0-9]+)\]/i.exec(output)?.[1] ?? null;
}

async function findSecretFiles(memoryRoot: string, files: string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(join(memoryRoot, ...file.split("/")), "utf-8");
    } catch {
      // Deleted or unreadable files cannot leak new content through auto-commit.
      continue;
    }
    if (containsSecretShape(content)) hits.push(file);
  }
  return hits;
}
