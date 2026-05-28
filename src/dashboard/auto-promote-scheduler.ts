import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcedurePropose } from "../cli/commands/procedure.js";
import { runThreadPropose } from "../cli/commands/thread.js";
import { loadMemoryConfig, type MemoryConfig } from "../storage/config.js";

export interface AutoPromoteScheduler {
  close(): void;
}

export interface AutoPromoteSchedulerOptions {
  vaultRoot: string;
  configLoader?: () => Promise<MemoryConfig>;
  intervalFactory?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFactory?: (handle: NodeJS.Timeout) => void;
  runner?: () => Promise<void>;
}

const CADENCE_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
} as const;

export async function createAutoPromoteScheduler(
  opts: AutoPromoteSchedulerOptions,
): Promise<AutoPromoteScheduler> {
  const config = await (opts.configLoader ?? (() => loadMemoryConfig(opts.vaultRoot)))();
  const autoPromote = readAutoPromoteConfig(config);
  const intervalFactory = opts.intervalFactory ?? setInterval;
  const clearIntervalFactory = opts.clearIntervalFactory ?? clearInterval;

  if (!autoPromote.enabled || autoPromote.cadence === "manual") {
    return { close: () => undefined };
  }

  const cadenceMs = CADENCE_MS[autoPromote.cadence];
  const handler = () => {
    void (opts.runner ?? (() => runAutoPromoteOnce(opts.vaultRoot)))();
  };
  const interval = intervalFactory(handler, cadenceMs);
  return {
    close: () => clearIntervalFactory(interval),
  };
}

export async function runAutoPromoteOnce(vaultRoot: string): Promise<void> {
  try {
    await runThreadPropose({ vaultRoot, apply: true, autoPromote: true });
    await runProcedurePropose({ vaultRoot, apply: true, autoPromote: true });
  } catch (error) {
    await appendFile(
      join(vaultRoot, "errors.log"),
      `[${new Date().toISOString()}] auto-promote scheduler failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
      "utf-8",
    );
  }
}

function readAutoPromoteConfig(config: MemoryConfig): {
  enabled: boolean;
  cadence: "daily" | "weekly" | "manual";
} {
  const record = typeof config.auto_promote === "object" && config.auto_promote !== null
    ? config.auto_promote as Record<string, unknown>
    : {};
  const cadence = record["cadence"];
  return {
    enabled: record["enabled"] === true,
    cadence: cadence === "daily" || cadence === "manual" ? cadence : "weekly",
  };
}
