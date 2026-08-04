import { loadErrorActivityEvents } from "../../../dashboard/loaders.js";
import { pass, warn, type CheckDescriptor, type RunCheckOptions, type VerifyCheckResult } from "./types.js";

const CHECK_ID = "storage.errors-log-burst";
const CHECK_LABEL = "errors.log burst activity";
const BURST_THRESHOLD = 50;
const BURST_WINDOW_MS = 10 * 60 * 1000;

export const errorsLogBurstCheck: CheckDescriptor = {
  id: CHECK_ID,
  label: CHECK_LABEL,
  roles: ["operator", "server"],
  run: checkErrorsLogBurst,
};

export async function checkErrorsLogBurst(ctx: RunCheckOptions): Promise<VerifyCheckResult> {
  try {
    const events = await loadErrorActivityEvents(ctx.vaultRoot);
    const nowMs = ctx.now().getTime();
    const cutoffMs = nowMs - BURST_WINDOW_MS;
    const errorCount = events.filter((event) => {
      const timestampMs = Date.parse(event.timestamp);
      return event.level !== "warn" && timestampMs >= cutoffMs && timestampMs <= nowMs;
    }).length;
    const detail = `${errorCount} non-Warning errors.log event(s) in the trailing 10 minutes`;
    if (errorCount > BURST_THRESHOLD) {
      return warn(
        CHECK_ID,
        CHECK_LABEL,
        detail,
        "inspect the recent errors.log entries and resolve the underlying burst",
      );
    }
    return pass(CHECK_ID, CHECK_LABEL, detail);
  } catch (error) {
    return warn(
      CHECK_ID,
      CHECK_LABEL,
      `unable to inspect errors.log: ${error instanceof Error ? error.message : String(error)}`,
      "inspect errors.log availability and permissions",
    );
  }
}
