import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";
import { schedulerStatePath } from "../storage/paths.js";
import { resolveWorkerPath } from "./worker-paths.js";
import { runCompile, runCompileDrain, type CompileDrainResult, type CompileResult } from "../cli/commands/compile.js";
import {
  emptyCompilePendingSummary,
  mutateCompileStateFile,
  scheduledCompilePromptPath,
  scheduledCompilePromptRelPath,
  type CompilePendingSummary,
} from "../compile/state.js";
import { runProcedurePropose } from "../cli/commands/procedure.js";
import { runThreadPropose } from "../cli/commands/thread.js";
import { loadMemoryConfig, resolveCompileConfig, type MemoryConfig, type ResolvedCompileConfig } from "../storage/config.js";
import type { VaultWriteCapability } from "../sync/vault-capability.js";
import { defaultFullCorpusAdmissionGate, type FullCorpusAdmissionGate } from "./full-corpus-admission.js";

export interface AutoPromoteScheduler {
  close(): void;
}

export interface AutoPromoteSchedulerOptions {
  vaultRoot: string;
  configLoader?: () => Promise<MemoryConfig>;
  intervalFactory?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFactory?: (handle: NodeJS.Timeout) => void;
  runner?: () => Promise<void>;
  compileRunner?: (opts?: DashboardCompileRunnerOptions) => Promise<DashboardCompileRunResult>;
  autoPromoteRunner?: () => Promise<void>;
  writeCapability?: VaultWriteCapability;
  fullCorpusGate?: FullCorpusAdmissionGate;
  now?: () => Date;
}

export interface DashboardCompileRunnerOptions {
  execute?: boolean;
  drain?: boolean;
  maxPasses?: number;
  rawFilter?: boolean;
}

export interface DashboardCompileRunResult {
  rawFilesIncluded: string[];
  rawFilesSkipped: CompileResult["rawFilesSkipped"];
  outputPath: string;
  rawRemaining: number;
  pendingSummary?: CompilePendingSummary;
  execution?: CompileResult["execution"];
  passes?: number;
  noiseOnlySkipped?: number;
  bytesReduced?: number;
}

interface ScheduledCompileSummary {
  rawFilesIncluded: string[];
  rawFilesSkipped: CompileResult["rawFilesSkipped"];
  rawRemaining: number;
  pendingSummary: CompilePendingSummary;
  execution?: CompileResult["execution"];
  operationsApplied: number;
  operationsProposed: number;
  passes: number;
  noiseOnlySkipped: number;
  bytesReduced: number;
}

const CADENCE_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
} as const;

/**
 * How often the scheduler wakes up to check whether any task's cadence has
 * elapsed. Cadences are measured against a PERSISTED per-task last-run stamp,
 * not process uptime: a plain daily setInterval never fired on a dashboard
 * that restarts more often than daily, and two same-cadence intervals with a
 * shared re-entrancy flag starved whichever registered second (observed as
 * thread/procedure proposals silently never running).
 */
const SCHEDULER_HEARTBEAT_MS = 15 * 60 * 1000;

type SchedulerState = Record<string, Record<string, string>>;

async function readSchedulerState(): Promise<SchedulerState> {
  try {
    const raw = await readFile(schedulerStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as SchedulerState) : {};
  } catch {
    return {};
  }
}

async function isSchedulerTaskDue(
  vaultRoot: string,
  task: string,
  cadenceMs: number,
  now: Date,
): Promise<boolean> {
  const last = (await readSchedulerState())[vaultRoot]?.[task];
  if (!last) return true; // Never ran (or state lost) — catch up now.
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  return now.getTime() - lastMs >= cadenceMs;
}

async function stampSchedulerRun(vaultRoot: string, task: string, now: Date): Promise<void> {
  const path = schedulerStatePath();
  const state = await readSchedulerState();
  (state[vaultRoot] ??= {})[task] = now.toISOString();
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

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
  const fullCorpusGate = opts.fullCorpusGate ?? defaultFullCorpusAdmissionGate;

  if (opts.writeCapability?.writable === false) {
    return { close: () => undefined };
  }

  const compileCadenceMs = compile.cadence === "manual" ? null : CADENCE_MS[compile.cadence];
  const autoPromoteCadenceMs = autoPromote.cadence === "manual" ? null : CADENCE_MS[autoPromote.cadence];
  const compileEnabled = compile.scheduled && compileCadenceMs !== null;
  const autoPromoteEnabled = autoPromote.enabled && autoPromoteCadenceMs !== null;
  if (!compileEnabled && !autoPromoteEnabled) {
    return { close: () => undefined };
  }

  const now = opts.now ?? (() => new Date());

  const runCompileTask = async (): Promise<void> => {
    // Default: isolate the full-corpus compile in a child process so its
    // multi-GB peak never touches the dashboard/app heap. An injected runner
    // (tests) runs in-process.
    if (opts.compileRunner) {
      await opts.compileRunner(scheduledCompileRunnerOptions(compile));
    } else {
      await runScheduledVaultTaskInChild(opts.vaultRoot, "compile");
    }
  };

  const runAutoPromoteTask = async (): Promise<void> => {
    const injectedAuto = opts.autoPromoteRunner ?? opts.runner;
    if (injectedAuto) {
      await injectedAuto();
    } else {
      await runScheduledVaultTaskInChild(opts.vaultRoot, "auto-promote");
    }
  };

  // Attempt one task: skip quietly when the gate is busy (stays due, retried
  // next heartbeat); stamp after any actual attempt — success or failure — so
  // a crashing task retries at its cadence instead of hot-looping.
  const attemptTask = async (task: string, label: string, run: () => Promise<void>): Promise<void> => {
    try {
      const admission = await fullCorpusGate.tryRunMaintenance(run);
      if (!admission.started) return;
    } catch (error) {
      await logSchedulerFailure(opts.vaultRoot, `${label} scheduler failed`, error);
    }
    await stampSchedulerRun(opts.vaultRoot, task, now());
  };

  const heartbeat = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      if (compileEnabled && await isSchedulerTaskDue(opts.vaultRoot, "compile", compileCadenceMs!, now())) {
        await attemptTask("compile", "compile", runCompileTask);
      }
      if (autoPromoteEnabled && await isSchedulerTaskDue(opts.vaultRoot, "auto-promote", autoPromoteCadenceMs!, now())) {
        await attemptTask("auto-promote", "auto-promote", runAutoPromoteTask);
      }
    } finally {
      running = false;
    }
  };

  intervals.push(intervalFactory(() => {
    void heartbeat();
  }, SCHEDULER_HEARTBEAT_MS));

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
  opts: DashboardCompileRunnerOptions = {},
): Promise<DashboardCompileRunResult> {
  const startedAt = new Date();
  const outputPath = scheduledCompilePromptPath(vaultRoot);
  const outputRelPath = scheduledCompilePromptRelPath();
  await mutateCompileStateFile(vaultRoot, (fresh) => ({
    ...fresh,
    status: "running",
    lastRun: null,
  }));
  const result = opts.drain
    ? summarizeScheduledDrain(await runCompileDrain({
        vaultRoot,
        outputPath,
        execute: opts.execute ?? false,
        maxPasses: opts.maxPasses,
        rawFilter: opts.rawFilter,
      }))
    : summarizeScheduledPass(await runCompile({
        vaultRoot,
        outputPath,
        execute: opts.execute,
        rawFilter: opts.rawFilter,
      }));
  const finishedAt = new Date();
  await mutateCompileStateFile(vaultRoot, (fresh) => ({
    ...fresh,
    status: "completed",
    lastRun: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      pagesCompiled: result.rawFilesIncluded.length,
      digestPath: outputRelPath,
      execute: opts.execute === true,
      operationsApplied: result.operationsApplied,
      operationsProposed: result.operationsProposed,
    },
  }));
  await appendFile(
    join(vaultRoot, "log.md"),
    `## [${finishedAt.toISOString()}] compile | scheduled prompt: ${result.rawFilesIncluded.length} raw included, ${result.pendingSummary.filesFullyDrained} already-drained, ${result.pendingSummary.filesWithPendingTail} pending tails, ${result.passes} pass(es), ${result.noiseOnlySkipped} noise-only skipped, ${result.bytesReduced} raw bytes reduced\n`,
    "utf-8",
  );
  return {
    rawFilesIncluded: result.rawFilesIncluded,
    rawFilesSkipped: result.rawFilesSkipped,
    outputPath: outputRelPath,
    rawRemaining: result.rawRemaining,
    pendingSummary: result.pendingSummary,
    execution: result.execution,
    passes: result.passes,
    noiseOnlySkipped: result.noiseOnlySkipped,
    bytesReduced: result.bytesReduced,
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

export type ScheduledVaultTaskKind = "compile" | "auto-promote" | "vault";

/**
 * Run a scheduled vault task in-process. This loads/processes the entire raw/
 * corpus, so it is only safe to call from a dedicated worker process (see
 * scheduled-vault-worker) — never inside the dashboard/Electron-main process,
 * where its multi-GB peak would OOM the app. The scheduler spawns a child that
 * calls this; tests and the worker entrypoint reuse it directly.
 */
export async function runScheduledVaultTask(
  vaultRoot: string,
  kind: ScheduledVaultTaskKind,
): Promise<void> {
  const config = await loadMemoryConfig(vaultRoot);
  const compile = readCompileConfig(config);
  if (kind === "compile") {
    await runScheduledCompileOnce(vaultRoot, scheduledCompileRunnerOptions(compile));
  } else if (kind === "auto-promote") {
    await runAutoPromoteOnce(vaultRoot);
  } else {
    await runScheduledVaultTasksOnce(vaultRoot, {
      compileRunner: () => runScheduledCompileOnce(vaultRoot, scheduledCompileRunnerOptions(compile)),
      autoPromoteRunner: () => runAutoPromoteOnce(vaultRoot),
    });
  }
}

function defaultVaultWorkerPath(): string {
  return resolveWorkerPath(import.meta.url, "scheduled-vault-worker.mjs");
}

/**
 * Spawn the scheduled vault task in a child process so its full-corpus memory
 * peak lives and dies in the child, isolated from the dashboard/app heap.
 * Resolves when the child exits 0; rejects on spawn error or non-zero exit.
 */
export function runScheduledVaultTaskInChild(
  vaultRoot: string,
  kind: ScheduledVaultTaskKind,
  opts: { spawnFn?: typeof spawn; workerPath?: string } = {},
): Promise<void> {
  const spawnFn = opts.spawnFn ?? spawn;
  const workerPath = opts.workerPath ?? defaultVaultWorkerPath();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnFn("node", ["--max-old-space-size=8192", workerPath, vaultRoot, kind], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`scheduled vault worker (${kind}) exited with code ${code ?? "unknown"}`));
    });
  });
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

function readCompileConfig(config: MemoryConfig): ResolvedCompileConfig {
  return resolveCompileConfig(config.compile);
}

function scheduledCompileRunnerOptions(compile: ResolvedCompileConfig): DashboardCompileRunnerOptions {
  if (!compile.drain) return { execute: compile.execute };
  return {
    execute: compile.execute,
    drain: true,
    maxPasses: compile.max_passes_per_run,
    rawFilter: compile.raw_filter,
  };
}

function summarizeScheduledPass(result: CompileResult): ScheduledCompileSummary {
  return {
    rawFilesIncluded: result.rawFilesIncluded,
    rawFilesSkipped: result.rawFilesSkipped,
    rawRemaining: countRemainingRawFiles(result.rawFilesSkipped),
    pendingSummary: result.pendingSummary,
    execution: result.execution,
    operationsApplied: result.execution?.applied.length ?? 0,
    operationsProposed: result.execution?.proposed.length ?? 0,
    passes: 1,
    noiseOnlySkipped: result.noiseOnlySkipped,
    bytesReduced: compileBytesReduced(result),
  };
}

function summarizeScheduledDrain(result: CompileDrainResult): ScheduledCompileSummary {
  const last = result.passes.at(-1);
  return {
    rawFilesIncluded: result.passes.flatMap((pass) => pass.rawFilesIncluded),
    rawFilesSkipped: last?.rawFilesSkipped ?? [],
    rawRemaining: result.rawFilesRemaining,
    pendingSummary: last?.pendingSummary ?? emptyCompilePendingSummary(),
    execution: last?.execution,
    operationsApplied: result.passes.reduce((sum, pass) => sum + (pass.execution?.applied.length ?? 0), 0),
    operationsProposed: result.passes.reduce((sum, pass) => sum + (pass.execution?.proposed.length ?? 0), 0),
    passes: result.passes.length,
    noiseOnlySkipped: result.passes.reduce((sum, pass) => sum + pass.noiseOnlySkipped, 0),
    bytesReduced: result.passes.reduce((sum, pass) => sum + compileBytesReduced(pass), 0),
  };
}

function compileBytesReduced(result: CompileResult): number {
  const stats = result.filterStats;
  if (!stats) return 0;
  return Math.max(0, stats.bytesIn - stats.bytesOut);
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

function countRemainingRawFiles(skipped: CompileResult["rawFilesSkipped"]): number {
  return skipped.filter((item) => item.reason !== "before since cutoff").length;
}
