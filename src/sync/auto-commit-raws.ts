import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { containsSecretShape, redactSecrets } from "../privacy/redaction.js";
import { atomicWrite } from "../storage/atomic-write.js";
import type { CommandRunner } from "./git-remote.js";

export interface AutoCommitOptions {
  memoryRoot: string;
  runner: CommandRunner;
  now?: () => Date;
}

export type AutoCommitResult =
  | { kind: "no-dirty-files" }
  | { kind: "committed"; filesCount: number; commitSha: string; redactedFiles?: string[] }
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

  // Defense-in-depth: capture-time redaction can be bypassed (content from an
  // older client version on another machine, a future writer that forgets to
  // redact, or a newly-discovered key shape). Re-scan here and redact in place
  // before committing rather than blocking — a single secret-shaped file must
  // never wedge the whole auto-commit batch. Only files redaction still cannot
  // clean are held back, so unknown shapes can't silently reach the remote.
  const secretFiles = await findSecretFiles(opts.memoryRoot, files);
  const redactedFiles: string[] = [];
  const unredactableFiles: string[] = [];
  for (const file of secretFiles) {
    const absolute = join(opts.memoryRoot, ...file.split("/"));
    let content: string;
    try {
      content = await readFile(absolute, "utf-8");
    } catch {
      continue; // Deleted/unreadable between scan and now — nothing to redact.
    }
    const cleaned = redactSecrets(content);
    if (containsSecretShape(cleaned)) {
      unredactableFiles.push(file); // Redaction can't remove it — never commit.
      continue;
    }
    await atomicWrite(absolute, cleaned);
    redactedFiles.push(file);
  }
  if (unredactableFiles.length > 0) {
    return { kind: "skipped-secret-shape", secretFiles: unredactableFiles };
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
    ...(redactedFiles.length > 0 ? { redactedFiles } : {}),
  };
}

function parseDirtyFiles(output: string): DirtyFile[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => parseStatusPath(line))
    .filter((path): path is string => path.length > 0)
    .filter((path) => !isTransientArtifact(path))
    .map((path) => ({
      path,
      isAutoCommitEligible: isAutoCommitEligiblePath(path),
    }));
}

// Internal artifacts that are never committable and must never block or count
// as dirt: the auto-push pending lock and atomic-write temp files
// (`<name>.<pid>.<ts>.<uuid>.tmp`). They appear transiently in
// `git status -uall` and previously tripped the "non-raw dirty" skip.
function isTransientArtifact(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return name === ".auto-push-pending.lock" || /\.\d+\.\d+\.[0-9a-fA-F-]+\.tmp$/.test(name);
}

function isAutoCommitEligiblePath(path: string): boolean {
  return isRawPath(path) || isSystemManagedPath(path);
}

function isRawPath(path: string): boolean {
  return path === "raw" || path.startsWith("raw/");
}

function isSystemManagedPath(path: string): boolean {
  return path === "log.md"
    || path === "config.yaml"
    || path === "index.md"
    || path === "schema.md"
    || path === "preferences.md"
    || path.startsWith("wiki/")
    || path.startsWith("embeddings/")
    || path.startsWith("prompts/");
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
