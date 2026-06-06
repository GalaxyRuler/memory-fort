import { stat } from "node:fs/promises";
import { join } from "node:path";
import { makeRealCommandRunner, type CommandRunner } from "../../../sync/git-remote.js";
import { pass, warn, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

const ID = "sync.uncommitted-vault";
const LABEL = "vault working tree has no stale uncommitted changes";
const TEN_MINUTES_MS = 10 * 60 * 1000;

export interface UncommittedVaultOptions extends VerifyCheckContext {
  runner?: CommandRunner;
  staleAfterMs?: number;
}

export const uncommittedVaultCheck: CheckDescriptor = {
  id: ID,
  label: LABEL,
  roles: ["operator"],
  run: checkUncommittedVault,
};

export async function checkUncommittedVault(opts: UncommittedVaultOptions): Promise<VerifyCheckResult> {
  const runner = opts.runner ?? makeRealCommandRunner();
  const status = await runner.run("git", ["status", "--porcelain"], { cwd: opts.vaultRoot });
  if (status.exitCode !== 0) {
    return warn(ID, LABEL, `unable to inspect git status: ${status.stderr.trim() || status.stdout.trim() || "unknown error"}`);
  }

  const relPaths = parsePorcelainPaths(status.stdout);
  if (relPaths.length === 0) return pass(ID, LABEL, "vault working tree clean");

  const staleAfterMs = opts.staleAfterMs ?? TEN_MINUTES_MS;
  const nowMs = opts.now().getTime();
  const stalePaths: string[] = [];
  for (const relPath of relPaths) {
    const changedAt = await lastModifiedMs(opts.vaultRoot, relPath);
    if (changedAt === null || nowMs - changedAt > staleAfterMs) stalePaths.push(relPath);
  }

  if (stalePaths.length > 0) {
    return warn(
      ID,
      LABEL,
      `${stalePaths.length} stale uncommitted vault change(s): ${stalePaths.slice(0, 5).join(", ")}`,
      "run `memory sync` or inspect pending vault mutations",
    );
  }

  return pass(ID, LABEL, `${relPaths.length} uncommitted vault change(s), all younger than 10m`);
}

function parsePorcelainPaths(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
    .map((path) => path.includes(" -> ") ? path.split(" -> ").at(-1)! : path)
    .map((path) => path.replace(/^"|"$/g, "").replace(/\\/g, "/"))
    .filter((path) => path.startsWith("wiki/") || path.startsWith("raw/"))
    .filter((path, index, paths) => paths.indexOf(path) === index);
}

async function lastModifiedMs(vaultRoot: string, relPath: string): Promise<number | null> {
  try {
    return (await stat(join(vaultRoot, ...relPath.split("/")))).mtimeMs;
  } catch {
    return null;
  }
}
