// Worker entry: runs a heavy vault task (scheduled compile / auto-promote, or an
// auto-heal tick) in its own process so the full-corpus memory peak is isolated
// from the dashboard (Electron-main) heap, where it would OOM-kill the app.
// Spawned by createAutoPromoteScheduler and createAutoHealScheduler.
//
// argv: <vaultRoot> <kind> [reconcile]
//   kind = compile | auto-promote | vault   -> scheduled compile / auto-promote
//   kind = auto-heal [reconcile=0|1]         -> one auto-heal tick
import { runScheduledVaultTask, type ScheduledVaultTaskKind } from "./auto-promote-scheduler.js";
import { runAutoHealTick } from "../retrieval/auto-heal.js";

const SCHEDULED_KINDS: ScheduledVaultTaskKind[] = ["compile", "auto-promote", "vault"];

function isScheduledKind(value: string | undefined): value is ScheduledVaultTaskKind {
  return value !== undefined && (SCHEDULED_KINDS as string[]).includes(value);
}

if (process.argv[1]?.endsWith("scheduled-vault-worker.mjs")) {
  const vaultRoot = process.argv[2];
  const kind = process.argv[3];
  const run = async (): Promise<void> => {
    if (kind === "auto-heal") {
      await runAutoHealTick({ memoryRoot: vaultRoot, reconcile: process.argv[4] === "1" });
      return;
    }
    if (isScheduledKind(kind)) {
      await runScheduledVaultTask(vaultRoot, kind);
      return;
    }
    throw new Error(`unknown task kind: ${kind ?? "(none)"}`);
  };

  if (!vaultRoot) {
    console.error("[scheduled-vault-worker] usage: scheduled-vault-worker.mjs <vaultRoot> <kind> [reconcile]");
    process.exit(2);
  } else {
    run()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(`[scheduled-vault-worker] ${(error as Error)?.message ?? String(error)}`);
        process.exit(1);
      });
  }
}
