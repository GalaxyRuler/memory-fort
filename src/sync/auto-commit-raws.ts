import type { CommandRunner } from "./git-remote.js";

export interface AutoCommitOptions {
  memoryRoot: string;
  runner: CommandRunner;
  now?: () => Date;
}

export type AutoCommitResult =
  | { kind: "no-dirty-files" }
  | { kind: "committed"; filesCount: number; commitSha: string }
  | { kind: "skipped-non-raw-dirty"; dirtyNonRawFiles: string[] };

interface DirtyFile {
  path: string;
  isRaw: boolean;
}

export async function autoCommitRawsIfDirty(opts: AutoCommitOptions): Promise<AutoCommitResult> {
  const status = await opts.runner.run("git", ["status", "--porcelain"], { cwd: opts.memoryRoot });
  if (status.exitCode !== 0) {
    throw new Error(`git status --porcelain failed: ${status.stderr.trim() || status.stdout.trim()}`);
  }

  const dirty = parseDirtyFiles(status.stdout);
  if (dirty.length === 0) return { kind: "no-dirty-files" };

  const nonRaw = dirty.filter((file) => !file.isRaw).map((file) => file.path);
  if (nonRaw.length > 0) {
    return { kind: "skipped-non-raw-dirty", dirtyNonRawFiles: nonRaw };
  }

  const rawFiles = [...new Set(dirty.map((file) => file.path))];
  const message = `chore: auto-capture ${rawFiles.length} raw observation file(s)`;
  const add = await opts.runner.run("git", ["add", "raw/"], { cwd: opts.memoryRoot });
  if (add.exitCode !== 0) {
    throw new Error(`git add raw/ failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }
  const commit = await opts.runner.run("git", ["commit", "-m", message], { cwd: opts.memoryRoot });
  if (commit.exitCode !== 0) {
    throw new Error(`git commit raw/ failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }

  return {
    kind: "committed",
    filesCount: rawFiles.length,
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
      isRaw: path === "raw" || path.startsWith("raw/"),
    }));
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
