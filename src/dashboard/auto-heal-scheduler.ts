import { spawn } from "node:child_process";
import { resolveWorkerPath } from "./worker-paths.js";
import type { MemoryConfig } from "../storage/config.js";
import {
  readAutoHealSettings,
  type AutoHealRunResult,
  type AutoHealTickOptions,
} from "../retrieval/auto-heal.js";

function defaultVaultWorkerPath(): string {
  return resolveWorkerPath(import.meta.url, "scheduled-vault-worker.mjs");
}

/**
 * Run one auto-heal tick in a child process. The reconciler loads the full
 * corpus (scope "all") to refresh embeddings, peaking into the GBs; doing that
 * in the dashboard (Electron-main) process OOM-killed the app, so it is
 * isolated here. Resolves on child exit 0; rejects on spawn error / non-zero.
 */
export function runAutoHealTickInChild(
  vaultRoot: string,
  reconcile: boolean,
  opts: { spawnFn?: typeof spawn; workerPath?: string } = {},
): Promise<void> {
  const spawnFn = opts.spawnFn ?? spawn;
  const workerPath = opts.workerPath ?? defaultVaultWorkerPath();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnFn("node", ["--max-old-space-size=8192", workerPath, vaultRoot, "auto-heal", reconcile ? "1" : "0"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`auto-heal worker exited with code ${code ?? "unknown"}`));
    });
  });
}

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
      if (opts.runTick) {
        // Injected (tests): run in-process.
        await opts.runTick({ memoryRoot: opts.vaultRoot, env: opts.env, reconcile });
      } else {
        // Default: isolate the full-corpus reconcile in a child process so its
        // multi-GB peak never touches the dashboard/app heap.
        await runAutoHealTickInChild(opts.vaultRoot, reconcile);
      }
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
