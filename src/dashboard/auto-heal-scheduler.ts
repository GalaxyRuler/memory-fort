import type { MemoryConfig } from "../storage/config.js";
import {
  readAutoHealSettings,
  runAutoHealTick,
  type AutoHealRunResult,
} from "../retrieval/auto-heal.js";

export interface AutoHealScheduler {
  close(): void;
}

export interface AutoHealSchedulerOptions {
  vaultRoot: string;
  config: MemoryConfig;
  env?: NodeJS.ProcessEnv;
  runTick?: (opts: { memoryRoot: string; env?: NodeJS.ProcessEnv }) => Promise<AutoHealRunResult>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export function createAutoHealScheduler(
  opts: AutoHealSchedulerOptions,
): AutoHealScheduler {
  const settings = readAutoHealSettings(opts.config);
  if (!settings.enabled) return { close: () => undefined };

  let running = false;
  const intervalMs = Math.max(1, settings.tickIntervalSeconds) * 1000;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await (opts.runTick ?? ((input) => runAutoHealTick(input)))({
        memoryRoot: opts.vaultRoot,
        env: opts.env,
      });
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
