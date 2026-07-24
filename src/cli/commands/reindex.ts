import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { memoryRoot } from "../../storage/paths.js";
import {
  rebuildIndexWithCompileLockHeld,
  type RebuildIndexResult,
} from "../../compile/index.js";
import { withCompileExecuteLock } from "../../compile/execute-lock.js";
import {
  beginIndexInvalidation,
  completeIndexInvalidation,
  readIndexGeneration,
} from "../../index/generation.js";
import { deleteIndexDbFiles, openIndexDb, resolveIndexDbPath } from "../../index/db.js";
import { reconcileIndex } from "../../index/reconcile.js";
import {
  completeRawCaptureEpochInvalidation,
  withCaptureSpoolAndRawLocks,
} from "../../hooks/raw-file.js";
import { withFileLock } from "../../storage/file-lock.js";
import {
  clearForgetRecovery,
  forgetApplyLockTarget,
  FORGET_APPLY_LOCK,
  readForgetRecovery,
  writeForgetRecovery,
  type ForgetRecoveryRecord,
} from "../../forget/recovery.js";

export interface ReindexOptions {
  vaultRoot?: string;
  plan?: boolean;
}

export async function runReindex(opts: ReindexOptions = {}): Promise<RebuildIndexResult> {
  const root = opts.vaultRoot ?? memoryRoot();
  return withFileLock(
    forgetApplyLockTarget(root),
    () => withCompileExecuteLock(root, async (ownership) => {
      if (opts.plan) return rebuildIndexWithCompileLockHeld(ownership, root, { plan: true });

      const generation = readIndexGeneration(root);
      let recovery: ForgetRecoveryRecord | null = null;
      if (generation.state === "invalidating") {
        recovery = await readForgetRecovery(root);
        if (!recovery || recovery.indexInvalidatingToken !== generation.token) {
          throw new Error(
            "memory reindex: index is invalidating without matching forget recovery metadata; refusing to guess ownership",
          );
        }
      } else {
        recovery = null;
      }

      return withCaptureSpoolAndRawLocks(
        recovery?.epochs.map((epoch) => epoch.rawPath) ?? [],
        async () => rebuildDerivedState(ownership, root, recovery),
      );
    }),
    FORGET_APPLY_LOCK,
  );
}

async function rebuildDerivedState(
  ownership: Parameters<typeof rebuildIndexWithCompileLockHeld>[0],
  root: string,
  existingRecovery: ForgetRecoveryRecord | null,
): Promise<RebuildIndexResult> {
  let recovery = existingRecovery;
  if (!recovery) {
    const token = randomUUID();
    recovery = await writeForgetRecovery(root, {
      indexInvalidatingToken: token,
      epochs: [],
    });
    await beginIndexInvalidation(root, token);
  }

  try {
    const preparationErrors = await removeDerivedState(root);
    if (preparationErrors.length > 0) {
      throw new Error(preparationErrors.join("; "));
    }
    const result = await rebuildIndexWithCompileLockHeld(ownership, root);
    const index = openIndexDb({ vaultRoot: root });
    try {
      await reconcileIndex(index, root);
    } finally {
      index.close();
    }
    await completeRawCaptureEpochInvalidation(recovery.epochs);
    await completeIndexInvalidation(root, recovery.indexInvalidatingToken);
    await clearForgetRecovery(root, recovery.indexInvalidatingToken).catch(() => undefined);
    return result;
  } catch (error) {
    const cleanupErrors = await removeDerivedState(root);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `memory reindex: rebuild failed; index remains invalidating: ${detail}${
        cleanupErrors.length > 0 ? `; ${cleanupErrors.join("; ")}` : ""
      }`,
      { cause: error },
    );
  }
}

async function removeDerivedState(root: string): Promise<string[]> {
  const cleanupErrors: string[] = [];
  try {
    deleteIndexDbFiles(resolveIndexDbPath({ vaultRoot: root }));
  } catch (error) {
    cleanupErrors.push(`SQLite cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await rm(join(root, "index.md"), { force: true });
  } catch (error) {
    cleanupErrors.push(`generated index cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return cleanupErrors;
}

export function formatReindexResult(result: RebuildIndexResult, opts: { plan?: boolean } = {}): string {
  const mode = opts.plan ? "plan" : "apply";
  const action = result.changed
    ? opts.plan ? "would rewrite" : "rewrote"
    : "unchanged";
  return [
    `Reindex ${mode} complete`,
    `  index:   ${action}`,
    `  entries: ${result.entries}`,
    `  path:    ${result.path}`,
    "",
  ].join("\n");
}
