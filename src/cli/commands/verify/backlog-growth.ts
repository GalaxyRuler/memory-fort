import {
  readCompileStateFile,
  summarizeCompilePending,
  writeCompileStateFile,
} from "../../../compile/state.js";
import {
  pass,
  warn,
  type CheckDescriptor,
  type RunCheckOptions,
  type VerifyCheckResult,
} from "./types.js";

export const backlogGrowthCheck: CheckDescriptor = {
  id: "compile.backlog-growth",
  label: "raw backlog is not growing unbounded",
  roles: ["operator"],
  run: checkBacklogGrowth,
};

export async function checkBacklogGrowth(
  ctx: RunCheckOptions,
): Promise<VerifyCheckResult> {
  const state = await readCompileStateFile(ctx.vaultRoot);
  const summary = await summarizeCompilePending(ctx.vaultRoot, state);
  const currentBytes = summary.pendingTailBytes;
  const previousBytes =
    typeof state.lastVerifyBacklogBytes === "number"
      ? state.lastVerifyBacklogBytes
      : undefined;

  await writeCompileStateFile(ctx.vaultRoot, {
    ...state,
    lastVerifyBacklogBytes: currentBytes,
  });

  if (previousBytes === undefined) {
    return pass(
      "compile.backlog-growth",
      `first backlog snapshot: ${formatBytes(currentBytes)} pending`,
    );
  }

  const delta = currentBytes - previousBytes;
  if (delta <= 0) {
    return pass(
      "compile.backlog-growth",
      `backlog shrank by ${formatBytes(Math.abs(delta))} (${formatBytes(currentBytes)} pending)`,
    );
  }

  return warn(
    "compile.backlog-growth",
    `raw backlog grew by ${formatBytes(delta)} since last verify`,
    `${formatBytes(previousBytes)} → ${formatBytes(currentBytes)}. Increase compile.total_max_bytes or run compile more frequently.`,
    "raise compile throughput or add a compress burn-down cron",
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
