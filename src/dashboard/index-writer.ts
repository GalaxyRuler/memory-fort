import { openIndexDb, type IndexDb } from "../index/db.js";
import { reconcileIndex } from "../index/reconcile.js";
import {
  defaultFullCorpusAdmissionGate,
  type FullCorpusAdmissionGate,
} from "./full-corpus-admission.js";
import type { DashboardServiceRuntimeEnv } from "./dashboard-service-supervisor.js";

export interface IndexWriterInit {
  vaultRoot: string;
  dashboardDistRoot?: string;
  runtimeEnv?: DashboardServiceRuntimeEnv;
  indexDbPath?: string;
  debounceMs?: number;
  intervalMs?: number;
}

export interface IndexWriterReady {
  url: string;
  port: number;
}

export interface IndexWriterParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
}

export interface IndexWriterOptions {
  parentPort: IndexWriterParentPort;
  openIndexDbImpl?: typeof openIndexDb;
  reconcileIndexImpl?: typeof reconcileIndex;
  fullCorpusGate?: FullCorpusAdmissionGate;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  exit?: (code: number) => void;
}

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_INTERVAL_MS = 60_000;

export function startIndexWriter(opts: IndexWriterOptions): Promise<IndexWriterReady> {
  const openIndexDbImpl = opts.openIndexDbImpl ?? openIndexDb;
  const reconcileIndexImpl = opts.reconcileIndexImpl ?? reconcileIndex;
  const fullCorpusGate = opts.fullCorpusGate ?? defaultFullCorpusAdmissionGate;
  const setTimer = opts.setTimeout ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimer = opts.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const exit = opts.exit ?? ((code) => process.exit(code));
  let indexDb: IndexDb | null = null;
  let init: IndexWriterInit | null = null;
  let timer: unknown = null;
  let running: Promise<void> | null = null;
  let shuttingDown = false;

  function schedule(delayMs: number): void {
    if (shuttingDown || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      running = runOnce().finally(() => {
        running = null;
      });
    }, Math.max(0, Math.trunc(delayMs)));
  }

  async function runOnce(): Promise<void> {
    if (!init || !indexDb || shuttingDown) return;
    try {
      const admission = await fullCorpusGate.tryRunMaintenance(async () => {
        try {
          const result = await reconcileIndexImpl(indexDb!, init!.vaultRoot);
          checkpointWal(indexDb!);
          markReconcileCheckpoint(indexDb!);
          clearLastError(indexDb!);
          opts.parentPort.postMessage({ type: "index-writer-reconciled", result });
          return result;
        } catch (error) {
          recordLastError(indexDb!, error);
          opts.parentPort.postMessage({
            type: "index-writer-error",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      });

      if (!admission.started) {
        opts.parentPort.postMessage({ type: "index-writer-skipped", reason: admission.reason });
      }
    } catch {
      // Error details are persisted into index meta and posted above.
    } finally {
      if (!shuttingDown && repeatIntervalMs(init) > 0) {
        schedule(repeatIntervalMs(init));
      }
    }
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    await running;
    indexDb?.close();
    indexDb = null;
    exit(0);
  }

  async function start(message: IndexWriterInit): Promise<IndexWriterReady> {
    init = message;
    indexDb = openIndexDbImpl(message.indexDbPath ?? { vaultRoot: message.vaultRoot });
    const ready = { url: "index-writer://ready", port: 0 };
    opts.parentPort.postMessage(ready);
    schedule(debounceMs(message));
    return ready;
  }

  const ready = new Promise<IndexWriterReady>((resolve, reject) => {
    opts.parentPort.on("message", (message) => {
      const payload = unwrapParentPortMessage(message);
      if (isShutdownMessage(payload)) {
        void shutdown().catch(reject);
        return;
      }
      if (!isInitMessage(payload)) {
        reject(new Error("index writer expected initial vaultRoot message"));
        return;
      }
      start(payload).then(resolve, reject);
    });
  });

  process.once("SIGTERM", () => {
    void shutdown();
  });

  return ready;
}

function checkpointWal(indexDb: IndexDb): void {
  indexDb.database.pragma("wal_checkpoint(TRUNCATE)");
}

function recordLastError(indexDb: IndexDb, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  indexDb.database
    .prepare<[string, string]>(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run("lastReconcileError", message);
  indexDb.database
    .prepare<[string, string]>(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run("lastReconcileErrorAt", new Date().toISOString());
  indexDb.database
    .prepare<[string, string]>(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run("activeReconcileState", "error");
}

function markReconcileCheckpoint(indexDb: IndexDb): void {
  indexDb.database
    .prepare<[string, string]>(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run("lastCompleteReconcileAt", new Date().toISOString());
  indexDb.database
    .prepare<[string, string]>(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run("activeReconcileState", "ready");
}

function clearLastError(indexDb: IndexDb): void {
  indexDb.database.prepare<[string]>("DELETE FROM meta WHERE key = ?").run("lastReconcileError");
  indexDb.database.prepare<[string]>("DELETE FROM meta WHERE key = ?").run("lastReconcileErrorAt");
}

function debounceMs(init: IndexWriterInit): number {
  return init.debounceMs ?? readEnvInt("MEMORY_INDEX_RECONCILE_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS);
}

function repeatIntervalMs(init: IndexWriterInit): number {
  return init.intervalMs ?? readEnvInt("MEMORY_INDEX_RECONCILE_INTERVAL_MS", DEFAULT_INTERVAL_MS);
}

function readEnvInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isInitMessage(message: unknown): message is IndexWriterInit {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { vaultRoot?: unknown }).vaultRoot === "string"
  );
}

function isShutdownMessage(message: unknown): boolean {
  return message === "shutdown" || (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "shutdown"
  );
}

function unwrapParentPortMessage(message: unknown): unknown {
  if (
    typeof message === "object" &&
    message !== null &&
    "data" in message &&
    "ports" in message
  ) {
    return (message as { data: unknown }).data;
  }
  return message;
}

const processWithParentPort = process as NodeJS.Process & { parentPort?: IndexWriterParentPort };

if (processWithParentPort.parentPort) {
  const parentPort = processWithParentPort.parentPort;
  startIndexWriter({ parentPort }).catch((error: unknown) => {
    console.error(`[index-writer] ${(error as Error)?.message ?? String(error)}`);
    process.exit(1);
  });
}
