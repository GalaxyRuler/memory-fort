import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { runCompile } from "../cli/commands/compile.js";
import { runProcedurePropose } from "../cli/commands/procedure.js";
import { runThreadPropose } from "../cli/commands/thread.js";
import { atomicWrite } from "../storage/atomic-write.js";
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
  compileRunner?: (opts?: { execute?: boolean }) => Promise<DashboardCompileRunResult>;
  autoPromoteRunner?: () => Promise<void>;
}

export interface DashboardCompileRunResult {
  rawFilesIncluded: string[];
  rawFilesSkipped: unknown[];
  outputPath: string;
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
  const compile = readCompileConfig(config);
  const intervalFactory = opts.intervalFactory ?? setInterval;
  const clearIntervalFactory = opts.clearIntervalFactory ?? clearInterval;
  const intervals: NodeJS.Timeout[] = [];
  let running = false;

  if (compile.scheduled && compile.cadence !== "manual") {
    intervals.push(intervalFactory(() => {
      if (running) return;
      running = true;
      void (opts.compileRunner ?? ((runOpts) => runScheduledCompileOnce(opts.vaultRoot, runOpts)))({ execute: compile.execute })
        .catch((error) => logSchedulerFailure(opts.vaultRoot, "compile scheduler failed", error))
        .finally(() => {
          running = false;
        });
    }, CADENCE_MS[compile.cadence]));
  }

  if (autoPromote.enabled && autoPromote.cadence !== "manual") {
    intervals.push(intervalFactory(() => {
      if (running) return;
      running = true;
      const autoRunner = opts.autoPromoteRunner ?? opts.runner ?? (() => runAutoPromoteOnce(opts.vaultRoot));
      const task = compile.scheduled
        ? runScheduledVaultTasksOnce(opts.vaultRoot, {
            compileRunner: opts.compileRunner
              ? () => opts.compileRunner!({ execute: compile.execute })
              : () => runScheduledCompileOnce(opts.vaultRoot, { execute: compile.execute }),
            autoPromoteRunner: autoRunner,
          })
        : autoRunner().catch((error) => logSchedulerFailure(opts.vaultRoot, "auto-promote scheduler failed", error));
      void task.finally(() => {
          running = false;
        });
    }, CADENCE_MS[autoPromote.cadence]));
  }

  if (intervals.length === 0) {
    return { close: () => undefined };
  }

  return {
    close: () => {
      for (const interval of intervals) clearIntervalFactory(interval);
    },
  };
}

export async function runScheduledVaultTasksOnce(
  vaultRoot: string,
  opts: {
    compileRunner?: () => Promise<unknown>;
    autoPromoteRunner?: () => Promise<void>;
  } = {},
): Promise<void> {
  try {
    await (opts.compileRunner ?? (() => runScheduledCompileOnce(vaultRoot)))();
    await (opts.autoPromoteRunner ?? (() => runAutoPromoteOnce(vaultRoot)))();
  } catch (error) {
    await logSchedulerFailure(vaultRoot, "vault scheduler failed", error);
  }
}

export async function runScheduledCompileOnce(
  vaultRoot: string,
  opts: { execute?: boolean } = {},
): Promise<DashboardCompileRunResult> {
  const startedAt = new Date();
  const outputPath = join(vaultRoot, "state", "scheduled-compile-prompt.md");
  await atomicWrite(join(vaultRoot, "state", "compile-state.json"), `${JSON.stringify({
    status: "running",
    lastRun: null,
  }, null, 2)}\n`);
  const result = await runCompile({ vaultRoot, outputPath, execute: opts.execute });
  const finishedAt = new Date();
  await atomicWrite(join(vaultRoot, "state", "compile-state.json"), `${JSON.stringify({
    status: "completed",
    lastRun: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      pagesCompiled: result.rawFilesIncluded.length,
      digestPath: "state/scheduled-compile-prompt.md",
      execute: opts.execute === true,
      operationsApplied: result.execution?.applied.length ?? 0,
      operationsProposed: result.execution?.proposed.length ?? 0,
    },
  }, null, 2)}\n`);
  await appendFile(
    join(vaultRoot, "log.md"),
    `## [${finishedAt.toISOString()}] compile | scheduled prompt: ${result.rawFilesIncluded.length} raw included, ${result.rawFilesSkipped.length} skipped\n`,
    "utf-8",
  );
  return {
    rawFilesIncluded: result.rawFilesIncluded,
    rawFilesSkipped: result.rawFilesSkipped,
    outputPath: "state/scheduled-compile-prompt.md",
  };
}

export async function runAutoPromoteOnce(vaultRoot: string): Promise<void> {
  try {
    await runThreadPropose({ vaultRoot, apply: true, autoPromote: true });
    await runProcedurePropose({ vaultRoot, apply: true, autoPromote: true });
  } catch (error) {
    await logSchedulerFailure(vaultRoot, "auto-promote scheduler failed", error);
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

function readCompileConfig(config: MemoryConfig): {
  scheduled: boolean;
  cadence: "daily" | "weekly" | "manual";
  execute: boolean;
} {
  const record = typeof config.compile === "object" && config.compile !== null
    ? config.compile as Record<string, unknown>
    : {};
  const cadence = record["cadence"];
  return {
    scheduled: record["scheduled"] === true,
    cadence: cadence === "weekly" || cadence === "manual" ? cadence : "daily",
    execute: record["execute"] === true,
  };
}

async function logSchedulerFailure(vaultRoot: string, label: string, error: unknown): Promise<void> {
  await appendFile(
    join(vaultRoot, "errors.log"),
    `[${new Date().toISOString()}] ${label}: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
    "utf-8",
  );
}
