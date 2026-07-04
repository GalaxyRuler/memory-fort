import { openIndexDb, type IndexDb } from "../index/db.js";
import { backfillVectors } from "../index/backfill.js";
import {
  createLocalBgeSmallEmbedClient,
  type EmbedClient,
  type EmbeddingProfileFingerprint,
} from "../index/embed.js";
import { reconcileIndex } from "../index/reconcile.js";
import { isIndexVectorsEnabled } from "../index/env.js";
import {
  defaultFullCorpusAdmissionGate,
  type FullCorpusAdmissionGate,
} from "./full-corpus-admission.js";
import {
  createProcessStatsMonitor,
  createProcessStatsResponse,
  isProcessStatsRequest,
} from "./process-stats.js";
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
  createVectorEmbedClientImpl?: () => Promise<VectorBackfillClient>;
  backfillVectorsImpl?: typeof backfillVectors;
  fullCorpusGate?: FullCorpusAdmissionGate;
  env?: NodeJS.ProcessEnv;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  exit?: (code: number) => void;
}

export interface VectorBackfillClient extends EmbedClient {
  readonly profile: EmbeddingProfileFingerprint;
}

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_INTERVAL_MS = 60_000;

export function startIndexWriter(opts: IndexWriterOptions): Promise<IndexWriterReady> {
  const openIndexDbImpl = opts.openIndexDbImpl ?? openIndexDb;
  const reconcileIndexImpl = opts.reconcileIndexImpl ?? reconcileIndex;
  const createVectorEmbedClientImpl = opts.createVectorEmbedClientImpl ?? createLocalBgeSmallEmbedClient;
  const backfillVectorsImpl = opts.backfillVectorsImpl ?? backfillVectors;
  const fullCorpusGate = opts.fullCorpusGate ?? defaultFullCorpusAdmissionGate;
  const env = opts.env ?? process.env;
  const setTimer = opts.setTimeout ?? ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimer = opts.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const exit = opts.exit ?? ((code) => process.exit(code));
  const processStats = createProcessStatsMonitor();
  let indexDb: IndexDb | null = null;
  let init: IndexWriterInit | null = null;
  let timer: unknown = null;
  let running: Promise<void> | null = null;
  let runningAbort: AbortController | null = null;
  let vectorClient: Promise<VectorBackfillClient> | null = null;
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
    const abort = new AbortController();
    runningAbort = abort;
    try {
      const admission = await fullCorpusGate.tryRunMaintenance(async () => {
        try {
          processStats.observe();
          const result = await reconcileIndexImpl(indexDb!, init!.vaultRoot, {
            onEvent: () => processStats.observe(),
          });
          processStats.observe();
          await runVectorBackfill(abort.signal);
          processStats.observe();
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
      if (runningAbort === abort) runningAbort = null;
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
    runningAbort?.abort();
    processStats.close();
    await running;
    indexDb?.close();
    indexDb = null;
    exit(0);
  }

  async function runVectorBackfill(signal: AbortSignal): Promise<void> {
    if (!indexDb || !isVectorBackfillEnabled(env)) return;
    vectorClient ??= createVectorEmbedClientImpl();
    const client = await vectorClient;
    await backfillVectorsImpl(indexDb.database, {
      embedder: client,
      profile: client.profile,
      signal,
    });
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
      if (isProcessStatsRequest(payload)) {
        opts.parentPort.postMessage(createProcessStatsResponse("index-writer", payload, processStats.snapshot()));
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

function isVectorBackfillEnabled(env: NodeJS.ProcessEnv): boolean {
  return isIndexVectorsEnabled(env);
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
  if (process.env["MEMORY_PHASE5_GATE_PROBE"] === "1") {
    import("./phase5-contention-spike.js")
      .then(({ startPhase5WriterGateProcess }) => startPhase5WriterGateProcess(parentPort))
      .catch((error: unknown) => {
        console.error(`[index-writer phase5-gate] ${(error as Error)?.message ?? String(error)}`);
        process.exit(1);
      });
  } else {
    startIndexWriter({ parentPort }).catch((error: unknown) => {
      console.error(`[index-writer] ${(error as Error)?.message ?? String(error)}`);
      process.exit(1);
    });
  }
}
