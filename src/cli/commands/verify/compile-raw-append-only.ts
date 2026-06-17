import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readCompileStateFile, readConsumedMap } from "../../../compile/state.js";
import { fail, pass, type CheckDescriptor, type RunCheckOptions, type VerifyCheckResult } from "./types.js";

const ID = "compile.raw-append-only";
const LABEL = "raw files have not regressed below compile watermarks";

export const compileRawAppendOnlyCheck: CheckDescriptor = {
  id: ID,
  label: LABEL,
  roles: ["operator"],
  run: checkCompileRawAppendOnly,
};

export async function checkCompileRawAppendOnly(
  ctx: RunCheckOptions,
): Promise<VerifyCheckResult> {
  let consumed;
  try {
    consumed = readConsumedMap(await readCompileStateFile(ctx.vaultRoot));
  } catch (error) {
    return fail(
      ID,
      LABEL,
      "inspect var/compile/state.json before running compile",
      `compile state unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const regressions: string[] = [];
  for (const [relPath, watermark] of Object.entries(consumed).sort(([a], [b]) => a.localeCompare(b))) {
    const fullPath = join(ctx.vaultRoot, ...relPath.split("/"));
    if (!existsSync(fullPath)) continue;
    const info = await stat(fullPath);
    if (info.size < watermark.bytes) {
      regressions.push(`${relPath}: ${formatBytes(info.size)} < ${formatBytes(watermark.bytes)}`);
    }
  }

  if (regressions.length > 0) {
    return fail(
      ID,
      LABEL,
      "restore raw file bytes from git/backup, or reset the affected compile watermark after review",
      regressions.join("; "),
    );
  }

  return pass(ID, LABEL, "all present raw files are at or above consumed watermarks");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
