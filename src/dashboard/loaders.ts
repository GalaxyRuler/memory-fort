import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export interface DashboardStatus {
  vaultRoot: string;
  repoHead: {
    sha: string;
    shortSha: string;
    subject: string;
    committedAt: string;
  } | null;
  counts: {
    wikiPages: number;
    rawObservations: number;
    crystals: number;
  };
  lastCompile: {
    timestamp: string;
    line: string;
  } | null;
  errorsLog: {
    sizeBytes: number;
    lastLine: string | null;
    isClean: boolean;
  };
  syncState: {
    lastSyncAttempt: string | null;
    lastSyncSuccess: string | null;
    pendingPushCount: number;
    conflictsPending: number;
    conflictFiles: string[];
  } | null;
  generatedAt: string;
}

export type RunGit = (opts: { cwd: string; args: string[] }) => Promise<string>;

const execFileAsync = promisify(execFile);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultRunGit(opts: { cwd: string; args: string[] }): Promise<string> {
  const { stdout } = await execFileAsync("git", opts.args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    windowsHide: true,
  });
  return stdout;
}

async function runBareRepoGit(vaultRoot: string, args: string[]): Promise<string> {
  const gitDir = join(dirname(vaultRoot), "memory.git");
  const { stdout } = await execFileAsync("git", [`--git-dir=${gitDir}`, ...args], {
    encoding: "utf-8",
    windowsHide: true,
  });
  return stdout;
}

export async function loadRepoHead(
  vaultRoot: string,
  runGit: RunGit = defaultRunGit,
): Promise<DashboardStatus["repoHead"]> {
  const args = ["log", "--format=%H%n%h%n%s%n%cI", "-n", "1"];
  let output = "";
  try {
    output = await runGit({ cwd: vaultRoot, args });
  } catch {
    try {
      output = await runBareRepoGit(vaultRoot, args);
    } catch {
      return null;
    }
  }

  const [sha = "", shortSha = "", subject = "", committedAt = ""] = output.trimEnd().split(/\r?\n/);
  if (!sha) return null;
  return { sha, shortSha, subject, committedAt };
}

async function countMarkdownFiles(root: string): Promise<number> {
  if (!(await pathExists(root))) return 0;
  let count = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      count += await countMarkdownFiles(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      count += 1;
    }
  }
  return count;
}

export async function loadCounts(vaultRoot: string): Promise<DashboardStatus["counts"]> {
  const [wikiPages, rawObservations, crystals] = await Promise.all([
    countMarkdownFiles(join(vaultRoot, "wiki")),
    countMarkdownFiles(join(vaultRoot, "raw")),
    countMarkdownFiles(join(vaultRoot, "crystals")),
  ]);
  return { wikiPages, rawObservations, crystals };
}

export async function loadLastCompile(vaultRoot: string): Promise<DashboardStatus["lastCompile"]> {
  const path = join(vaultRoot, "log.md");
  if (!(await pathExists(path))) return null;
  const content = await readFile(path, "utf-8");
  let last: DashboardStatus["lastCompile"] = null;
  for (const line of content.split(/\r?\n/)) {
    const match = /^## \[(.*)\] compile \|/.exec(line);
    if (match) {
      last = { timestamp: match[1]!, line };
    }
  }
  return last;
}

export async function loadErrorsLog(vaultRoot: string): Promise<DashboardStatus["errorsLog"]> {
  const path = join(vaultRoot, "errors.log");
  if (!(await pathExists(path))) {
    return { sizeBytes: 0, lastLine: null, isClean: true };
  }
  const info = await stat(path);
  if (info.size === 0) {
    return { sizeBytes: 0, lastLine: null, isClean: true };
  }
  const content = await readFile(path, "utf-8");
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  return {
    sizeBytes: info.size,
    lastLine: lines.at(-1) ?? null,
    isClean: info.size === 0,
  };
}

export async function loadSyncState(vaultRoot: string): Promise<DashboardStatus["syncState"]> {
  const path = join(vaultRoot, ".sync-state.json");
  if (!(await pathExists(path))) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    return {
      lastSyncAttempt: typeof parsed["last_sync_attempt"] === "string" ? parsed["last_sync_attempt"] : null,
      lastSyncSuccess: typeof parsed["last_sync_success"] === "string" ? parsed["last_sync_success"] : null,
      pendingPushCount: typeof parsed["pending_push_count"] === "number" ? parsed["pending_push_count"] : 0,
      conflictsPending: typeof parsed["conflicts_pending"] === "number" ? parsed["conflicts_pending"] : 0,
      conflictFiles: Array.isArray(parsed["conflict_files"])
        ? parsed["conflict_files"].filter((value): value is string => typeof value === "string")
        : [],
    };
  } catch (err) {
    console.warn(`dashboard: unable to read sync state: ${(err as Error).message}`);
    return null;
  }
}

export async function loadDashboardStatus(vaultRoot: string): Promise<DashboardStatus> {
  const [repoHead, counts, lastCompile, errorsLog, syncState] = await Promise.all([
    loadRepoHead(vaultRoot),
    loadCounts(vaultRoot),
    loadLastCompile(vaultRoot),
    loadErrorsLog(vaultRoot),
    loadSyncState(vaultRoot),
  ]);

  return {
    vaultRoot,
    repoHead,
    counts,
    lastCompile,
    errorsLog,
    syncState,
    generatedAt: new Date().toISOString(),
  };
}
