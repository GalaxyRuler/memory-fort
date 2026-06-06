import type { MemoryConfig } from "../storage/config.js";
import {
  readAutoHealSettings,
  runAutoHealTick,
  type AutoHealRunResult,
  type AutoHealTickOptions,
} from "../retrieval/auto-heal.js";

export interface AutoHealScheduler {
  close(): void;
}

export interface AutoHealSchedulerOptions {
  vaultRoot: string;
  config: MemoryConfig;
  env?: NodeJS.ProcessEnv;
  runTick?: (opts: AutoHealTickOptions) => Promise<AutoHealRunResult>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export function createAutoHealScheduler(
  opts: AutoHealSchedulerOptions,
): AutoHealScheduler {
  const settings = readAutoHealSettings(opts.config);
  if (!settings.enabled) return { close: () => undefined };

  let running = false;
  const tickIntervalMs = Math.max(1, settings.tickIntervalSeconds) * 1000;
  const captureIntervalMs = settings.captureDebounceSeconds > 0
    ? Math.max(1, settings.captureDebounceSeconds) * 1000
    : tickIntervalMs;
  const intervalMs = Math.min(tickIntervalMs, captureIntervalMs);
  let lastReconcilerAt = Date.now();
  const run = async () => {
    if (running) return;
    running = true;
    const reconcile = Date.now() - lastReconcilerAt >= tickIntervalMs;
    try {
      await (opts.runTick ?? ((input) => runAutoHealTick(input)))({
        memoryRoot: opts.vaultRoot,
        env: opts.env,
        reconcile,
      });
      if (reconcile) {
        lastReconcilerAt = Date.now();
      }
    } catch {
      // Auto-heal is fail-soft; per-call outcomes are persisted in auto-heal.jsonl.
    } finally {
      running = false;
    }
  };

  const setIntervalImpl = opts.setIntervalFn ?? setInterval;
  const clearIntervalImpl = opts.clearIntervalFn ?? clearInterval;
  const timer = setIntervalImpl(run, intervalMs);
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    close: () => clearIntervalImpl(timer),
  };
}
