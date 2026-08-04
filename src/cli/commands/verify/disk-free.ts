import * as fsPromises from "node:fs/promises";
import { fail, pass, skip, warn, type CheckDescriptor, type RunCheckOptions, type VerifyCheckResult } from "./types.js";

export interface StatfsResult {
  blocks: number | bigint;
  bavail: number | bigint;
}

export type StatfsFn = (path: string) => Promise<StatfsResult>;

const CHECK_ID = "storage.disk-free";
const CHECK_LABEL = "vault volume disk free";

export const diskFreeCheck: CheckDescriptor = {
  id: CHECK_ID,
  label: CHECK_LABEL,
  roles: ["operator", "server"],
  run: checkDiskFree,
};

export async function checkDiskFree(
  ctx: RunCheckOptions,
  statfsFn: StatfsFn | null | undefined = nodeStatfs(),
): Promise<VerifyCheckResult> {
  if (!statfsFn) {
    return skip(CHECK_ID, CHECK_LABEL, "n/a: fs.statfs unavailable");
  }

  let stats: StatfsResult;
  try {
    stats = await statfsFn(ctx.vaultRoot);
  } catch (error) {
    return skip(
      CHECK_ID,
      CHECK_LABEL,
      `n/a: fs.statfs unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const blocks = Number(stats.blocks);
  const available = Number(stats.bavail);
  if (!Number.isFinite(blocks) || blocks <= 0 || !Number.isFinite(available) || available < 0) {
    return skip(CHECK_ID, CHECK_LABEL, "n/a: fs.statfs returned invalid volume statistics");
  }

  const freePercent = Math.max(0, Math.min(100, (available / blocks) * 100));
  const detail = `${freePercent.toFixed(1)}% free on vault volume`;
  if (freePercent < 5) {
    return fail(
      CHECK_ID,
      CHECK_LABEL,
      "free disk space on the vault volume before running more capture or compile work",
      detail,
    );
  }
  if (freePercent < 10) {
    return warn(
      CHECK_ID,
      CHECK_LABEL,
      detail,
      "free disk space on the vault volume soon",
    );
  }
  return pass(CHECK_ID, CHECK_LABEL, detail);
}

function nodeStatfs(): StatfsFn | undefined {
  const candidate = (fsPromises as unknown as { statfs?: StatfsFn }).statfs;
  return typeof candidate === "function" ? candidate : undefined;
}
