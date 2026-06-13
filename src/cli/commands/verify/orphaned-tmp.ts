import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { pass, warn, type CheckDescriptor, type VerifyCheckResult, type RunCheckOptions } from "./types.js";

const STALE_TMP_MS = 60 * 60 * 1000;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const TMP_RE = /\.tmp$/;

export const orphanedTmpCheck: CheckDescriptor = {
  id: "storage.orphaned-tmp",
  label: "no orphaned atomic-write temp files",
  roles: ["operator"],
  run: checkOrphanedTmp,
};

export async function checkOrphanedTmp(ctx: RunCheckOptions): Promise<VerifyCheckResult> {
  const stale: string[] = [];
  const nowMs = ctx.now().getTime();

  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() && TMP_RE.test(entry.name)) {
        const info = await stat(full).catch(() => null);
        if (info && nowMs - info.mtimeMs > STALE_TMP_MS) {
          stale.push(relative(ctx.vaultRoot, full).replace(/\\/g, "/"));
        }
      }
    }
  }

  await walk(ctx.vaultRoot);
  if (stale.length === 0) {
    return pass("storage.orphaned-tmp", "no orphaned atomic-write temp files");
  }
  const shown = stale.slice(0, 5).join(", ");
  const suffix = stale.length > 5 ? ` (+${stale.length - 5} more)` : "";
  return warn(
    "storage.orphaned-tmp",
    `${stale.length} stale .tmp file(s) from interrupted writes`,
    `${shown}${suffix}`,
    "a process crashed mid-write; the target files are intact -- delete the listed .tmp files",
  );
}
