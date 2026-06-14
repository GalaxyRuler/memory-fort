import { readCompileStateFile, summarizeCompilePending } from "../../../compile/state.js";
import { loadMemoryConfig, resolveCompileConfig } from "../../../storage/config.js";
import { pass, skip, warn, type CheckDescriptor, type RunCheckOptions, type VerifyCheckResult } from "./types.js";

const ID = "compile.filter-health";
const LABEL = "compile raw filter health";
const MIN_REDUCTION_PCT = 20;

export const compileFilterHealthCheck: CheckDescriptor = {
  id: ID,
  label: LABEL,
  roles: ["operator"],
  run: checkCompileFilterHealth,
};

export async function checkCompileFilterHealth(
  ctx: RunCheckOptions,
): Promise<VerifyCheckResult> {
  const config = await loadMemoryConfig(ctx.vaultRoot);
  const compileConfig = resolveCompileConfig(config.compile);
  if (!compileConfig.raw_filter) {
    return skip(ID, LABEL, "compile.raw_filter disabled");
  }

  let state;
  try {
    state = await readCompileStateFile(ctx.vaultRoot);
  } catch (error) {
    return warn(ID, LABEL, `compile state unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const stats = state.lastFilterStats;
  if (!stats || stats.bytesIn <= 0) {
    return warn(
      ID,
      LABEL,
      "compile.raw_filter enabled but no filter stats have been recorded",
      "run memory compile --filter-report --json or the scheduled filtered compile once",
    );
  }

  const summary = await summarizeCompilePending(ctx.vaultRoot, state);
  const reduction = reductionPct(stats.bytesIn, stats.bytesOut);
  const currentBacklogBytes = summary.pendingTailBytes;
  const previousBacklogBytes = typeof state.lastVerifyBacklogBytes === "number"
    ? state.lastVerifyBacklogBytes
    : undefined;
  const detail = [
    `reduction ${formatPct(reduction)} (${formatBytes(stats.bytesIn)} -> ${formatBytes(stats.bytesOut)})`,
    `stripped ${formatStrippedClasses(stats.strippedByClass)}`,
    `backlog ${formatBytes(currentBacklogBytes)}`,
  ].join("; ");

  if (reduction < MIN_REDUCTION_PCT) {
    return warn(
      ID,
      LABEL,
      `${detail}; reduction below ${MIN_REDUCTION_PCT}%`,
      "review compile.raw_filter classes before enabling default filtered compile",
    );
  }

  if (previousBacklogBytes !== undefined && currentBacklogBytes > previousBacklogBytes) {
    return warn(
      ID,
      LABEL,
      `${detail}; backlog grew by ${formatBytes(currentBacklogBytes - previousBacklogBytes)} since last verify`,
      "increase compile throughput or run a bounded compile drain",
    );
  }

  return pass(ID, LABEL, detail);
}

function reductionPct(bytesIn: number, bytesOut: number): number {
  if (bytesIn <= 0) return 0;
  return Math.round((1 - bytesOut / bytesIn) * 10_000) / 100;
}

function formatPct(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(2)}%`;
}

function formatStrippedClasses(classes: Record<string, number>): string {
  const entries = Object.entries(classes).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "(none)";
  return entries.map(([name, bytes]) => `${name}: ${formatBytes(bytes)}`).join(", ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
