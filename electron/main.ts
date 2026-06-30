import { app, BrowserWindow, shell, utilityProcess } from "electron";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  createDashboardServiceSupervisor,
  type DashboardServiceSupervisor,
  type DashboardServiceChild,
  type DashboardServiceMainRuntimeEnv,
  type DashboardServiceRuntimeEnv,
} from "../src/dashboard/dashboard-service-supervisor.js";

// main heap is ~4GB-capped; dashboard server work runs in a utility process.

const execFileAsync = promisify(execFile);

// Prevent two MemoryFort windows competing on port 4410
const isCapabilityTest = process.env["MEMORY_CAP_TEST"] === "1";
const isCapabilityProbe = process.env["MEMORY_CAP_PROBE"] === "1";
const isIndexConcurrencySpike = process.env["MEMORY_INDEX_SPIKE"] === "1";
const isIndexGateProbe = process.env["MEMORY_INDEX_GATE_PROBE"] === "1";
const gotLock = isCapabilityTest || isCapabilityProbe || isIndexConcurrencySpike || isIndexGateProbe || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let dashboardSupervisor: DashboardServiceSupervisor | null = null;
let indexWriterSupervisor: DashboardServiceSupervisor | null = null;
let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  const appPath = app.getAppPath();
  const vaultRoot = process.env["MEMORY_ROOT"] ?? join(app.getPath("home"), ".memory");
  const dashboardDistRoot = join(appPath, "dist", "dashboard-ui");
  const dashboardServicePath = join(appPath, "dist", "dashboard", "dashboard-service.mjs");
  const indexWriterPath = join(appPath, "dist", "dashboard", "index-writer.mjs");
  const runtimeEnv = createMainRuntimeEnv(appPath, dashboardServicePath);
  console.info(`[memory-fort runtime main] ${JSON.stringify(runtimeEnv)}`);
  if (isIndexSearchEnabled()) {
    startIndexWriterSupervisor({
      appPath,
      vaultRoot,
      dashboardDistRoot,
      indexWriterPath,
    });
  }
  dashboardSupervisor = createDashboardServiceSupervisor({
    servicePath: dashboardServicePath,
    vaultRoot,
    dashboardDistRoot,
    fork: (servicePath) => forkDashboardUtilityProcess(servicePath, appPath),
    runtimeEnv,
    onRuntimeEnv: logUtilityRuntimeEnv,
    onReady: (ready) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        void mainWindow.loadURL(ready.url);
      }
    },
  });
  let dashboard: { url: string };
  try {
    dashboard = await dashboardSupervisor.start();
  } catch (error) {
    console.error("dashboard service failed to start", error);
    indexWriterSupervisor?.stop();
    indexWriterSupervisor = null;
    await createStartupErrorWindow(error);
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "MemoryFort",
    icon: join(app.getAppPath(), "assets", "memory_fort_icon_512.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  await mainWindow.loadURL(dashboard.url);

  // External links open in system browser, not inside the app window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function isIndexSearchEnabled(): boolean {
  return process.env["MEMORY_INDEX_SEARCH"] === "1";
}

function startIndexWriterSupervisor(opts: {
  appPath: string;
  vaultRoot: string;
  dashboardDistRoot: string;
  indexWriterPath: string;
}): void {
  const runtimeEnv = createMainRuntimeEnv(opts.appPath, opts.indexWriterPath);
  console.info(`[memory-fort index-writer runtime main] ${JSON.stringify(runtimeEnv)}`);
  indexWriterSupervisor = createDashboardServiceSupervisor({
    servicePath: opts.indexWriterPath,
    vaultRoot: opts.vaultRoot,
    dashboardDistRoot: opts.dashboardDistRoot,
    fork: (servicePath) => forkDashboardUtilityProcess(servicePath, opts.appPath),
    runtimeEnv,
    onRuntimeEnv: logUtilityRuntimeEnv,
    onMessage: logIndexWriterMessage,
  });
  void indexWriterSupervisor.start().catch((error) => {
    console.error("index writer failed to start", error);
  });
}

function logIndexWriterMessage(message: unknown): void {
  console.info(`[memory-fort index-writer] ${JSON.stringify(message)}`);
}

async function createStartupErrorWindow(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  mainWindow = new BrowserWindow({
    width: 820,
    height: 420,
    minWidth: 640,
    minHeight: 360,
    title: "MemoryFort failed to start",
    icon: join(app.getAppPath(), "assets", "memory_fort_icon_512.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const body = encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>MemoryFort failed to start</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 32px; color: #171717; background: #fafafa; }
      main { max-width: 720px; }
      h1 { font-size: 22px; margin: 0 0 12px; }
      pre { white-space: pre-wrap; background: #f0f0f0; padding: 14px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>MemoryFort failed to start</h1>
      <p>The dashboard service did not become ready.</p>
      <pre>${escapeHtml(message)}</pre>
    </main>
  </body>
</html>`);
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${body}`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function createMainRuntimeEnv(appPath: string, servicePath: string): DashboardServiceMainRuntimeEnv {
  return {
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    modules: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    appPath,
    servicePath,
    parentPid: process.pid,
  };
}

function logUtilityRuntimeEnv(env: DashboardServiceRuntimeEnv): void {
  console.info(`[memory-fort runtime utility] ${JSON.stringify(env)}`);
}

function forkDashboardUtilityProcess(entryPath: string, appPath: string): DashboardServiceChild {
  const child = utilityProcess.fork(entryPath, [], createDashboardUtilityForkOptions(appPath)) as unknown as DashboardServiceChild;
  child.stdout?.on("data", (chunk: Buffer | string) => {
    console.info(`[memory-fort utility stdout] ${String(chunk).trimEnd()}`);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    console.error(`[memory-fort utility stderr] ${String(chunk).trimEnd()}`);
  });
  return child;
}

function createDashboardUtilityForkOptions(appPath: string): Parameters<typeof utilityProcess.fork>[2] {
  const options: Parameters<typeof utilityProcess.fork>[2] = {
    cwd: appPath,
    stdio: "pipe",
    env: {
      ...process.env,
      MEMORY_FORT_APP_PATH: appPath,
    },
  };
  if (process.platform === "darwin") {
    options.allowLoadingUnsignedLibraries = true;
  }
  return options;
}

type CapabilityProbePhase = "write-hold" | "reopen-verify";

interface CapabilityProbeRun {
  readonly child: DashboardServiceChild;
  readonly pid: number;
  readonly exit: Promise<CapabilityProbeExit>;
}

interface CapabilityProbeExit {
  readonly code: number | null;
  readonly signal: string | null;
}

interface CapabilityProbeRunOptions {
  readonly appPath: string;
  readonly probePath: string;
  readonly vaultRoot: string;
  readonly dashboardDistRoot: string;
  readonly runtimeEnv: DashboardServiceMainRuntimeEnv;
  readonly probeDir: string;
  readonly phase: CapabilityProbePhase;
}

async function runInstalledCapabilityProbe(): Promise<void> {
  const appPath = app.getAppPath();
  process.env["MEMORY_FORT_APP_PATH"] = appPath;
  const dashboardDistRoot = join(appPath, "dist", "dashboard-ui");
  const probePath = join(appPath, "dist", "index", "native", "capability-probe.mjs");
  const runtimeEnv = createMainRuntimeEnv(appPath, probePath);
  const probeDir = await createInstalledCapabilityProbeDir();
  console.info(`[cap-probe main] ${JSON.stringify(runtimeEnv)}`);
  await logCapabilityProbeTransition(probeDir, `stable probe dir ${probeDir}`);
  await logCapabilityProbeTransition(probeDir, `runtime ${JSON.stringify(runtimeEnv)}`);

  const vaultRoot = process.env["MEMORY_ROOT"] ?? join(app.getPath("temp"), "Memory Fort cap probe vault Ω");
  const common = {
    appPath,
    probePath,
    vaultRoot,
    dashboardDistRoot,
    runtimeEnv,
    probeDir,
  } satisfies Omit<CapabilityProbeRunOptions, "phase">;

  await runCapabilityProbeWriteHold(common);
  await runCapabilityProbeReopenVerify(common);
}

function logCapabilityProbeMessage(message: unknown): void {
  if (typeof message === "object" && message !== null) {
    const type = (message as { type?: unknown }).type;
    const line = (message as { line?: unknown }).line;
    const error = (message as { error?: unknown }).error;
    if (type === "cap-probe-log" && typeof line === "string") {
      console.info(`[cap-probe child] ${line}`);
      return;
    }
    if (type === "cap-probe-fail" && typeof error === "string") {
      console.error(`[cap-probe child] ${error}`);
      return;
    }
  }
  console.info(`[cap-probe child] ${JSON.stringify(message)}`);
}

async function createInstalledCapabilityProbeDir(): Promise<string> {
  const base = resolve(process.env["MEMORY_CAP_PROBE_LOG_DIR"] ?? tmpdir());
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "Memory Fort cap probe Ω-"));
}

async function runCapabilityProbeWriteHold(
  opts: Omit<CapabilityProbeRunOptions, "phase">,
): Promise<void> {
  await logCapabilityProbeTransition(opts.probeDir, "fork write-hold");
  const run = await forkCapabilityProbeChild({ ...opts, phase: "write-hold" });
  try {
    await waitForCapabilityProbeLine(run, "wrote-uncheckpointed ok", 45_000);
    const walSize = await assertCapabilityProbeWalNonEmpty(opts.probeDir);
    await logCapabilityProbeTransition(
      opts.probeDir,
      `parent confirmed non-empty WAL before forced kill pid=${run.pid} size=${walSize}`,
    );
    const killMethod = await forceKillCapabilityProbeChild(run.pid);
    await logCapabilityProbeTransition(opts.probeDir, `forced kill sent pid=${run.pid} method=${killMethod}`);
    const exit = await waitForCapabilityProbeExit(run.exit, 15_000);
    if (exit.code === 0 && !exit.signal) {
      throw new Error(`forced kill reported clean exit for pid=${run.pid}`);
    }
    await logCapabilityProbeTransition(
      opts.probeDir,
      `forced-kill confirmed pid=${run.pid} code=${String(exit.code)} signal=${exit.signal ?? "n/a"}`,
    );
  } catch (error) {
    try {
      run.child.kill();
    } catch {
      // Preserve the original probe failure.
    }
    throw error;
  }
}

async function runCapabilityProbeReopenVerify(
  opts: Omit<CapabilityProbeRunOptions, "phase">,
): Promise<void> {
  await logCapabilityProbeTransition(opts.probeDir, "fork reopen-verify");
  const run = await forkCapabilityProbeChild({ ...opts, phase: "reopen-verify" });
  try {
    await waitForCapabilityProbeReady(run, 60_000);
    run.child.postMessage({ type: "shutdown" });
    let exit: CapabilityProbeExit;
    try {
      exit = await waitForCapabilityProbeExit(run.exit, 5_000);
    } catch {
      await logCapabilityProbeTransition(opts.probeDir, "reopen-verify graceful shutdown timed out; sending utilityProcess.kill()");
      run.child.kill();
      exit = await waitForCapabilityProbeExit(run.exit, 10_000);
    }
    await logCapabilityProbeTransition(
      opts.probeDir,
      `reopen-verify exited after completion code=${String(exit.code)} signal=${exit.signal ?? "n/a"}`,
    );
  } catch (error) {
    try {
      run.child.kill();
    } catch {
      // Preserve the original probe failure.
    }
    throw error;
  }
}

async function forkCapabilityProbeChild(opts: CapabilityProbeRunOptions): Promise<CapabilityProbeRun> {
  const child = forkDashboardUtilityProcess(opts.probePath, opts.appPath);
  const pid = await waitForCapabilityProbePid(child, 10_000);
  const runtimeEnv: DashboardServiceRuntimeEnv = {
    ...opts.runtimeEnv,
    utilityChildPid: pid,
  };
  logUtilityRuntimeEnv(runtimeEnv);
  const exit = new Promise<CapabilityProbeExit>((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolveExit({ code, signal: signal ?? null });
    });
  });
  child.postMessage({
    vaultRoot: opts.vaultRoot,
    dashboardDistRoot: opts.dashboardDistRoot,
    runtimeEnv,
    probeDir: opts.probeDir,
    probePhase: opts.phase,
  });
  return { child, pid, exit };
}

function waitForCapabilityProbePid(child: DashboardServiceChild, timeoutMs: number): Promise<number> {
  if (typeof child.pid === "number") return Promise.resolve(child.pid);

  return new Promise((resolvePid, reject) => {
    let settled = false;
    const finish = (pid: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      if (typeof pid !== "number") {
        reject(new Error("capability probe utilityProcess did not expose a child PID after spawn"));
        return;
      }
      resolvePid(pid);
    };
    const timer = setTimeout(() => {
      finish(null, new Error(`timed out waiting for capability probe PID after ${timeoutMs}ms`));
    }, timeoutMs);
    const childEvents = child as DashboardServiceChild & {
      once(event: string, listener: (...args: unknown[]) => void): unknown;
    };
    childEvents.once("spawn", () => finish(typeof child.pid === "number" ? child.pid : null));
    childEvents.once("exit", (code, signal) => {
      finish(
        null,
        new Error(`capability probe exited before spawn: code=${String(code)} signal=${String(signal ?? "n/a")}`),
      );
    });
    if (typeof child.pid === "number") finish(child.pid);
  });
}

function waitForCapabilityProbeReady(run: CapabilityProbeRun, timeoutMs: number): Promise<void> {
  return waitForCapabilityProbeMessage(run, timeoutMs, (message) => {
    if (typeof message !== "object" || message === null) return false;
    return (
      (message as { type?: unknown }).type === "cap-probe-ready" &&
      typeof (message as { url?: unknown }).url === "string" &&
      typeof (message as { port?: unknown }).port === "number"
    );
  });
}

function waitForCapabilityProbeLine(
  run: CapabilityProbeRun,
  needle: string,
  timeoutMs: number,
): Promise<void> {
  return waitForCapabilityProbeMessage(run, timeoutMs, (message) => {
    return (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "cap-probe-log" &&
      typeof (message as { line?: unknown }).line === "string" &&
      (message as { line: string }).line.includes(needle)
    );
  });
}

function waitForCapabilityProbeMessage(
  run: CapabilityProbeRun,
  timeoutMs: number,
  matches: (message: unknown) => boolean,
): Promise<void> {
  return new Promise((resolveMessage, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.child.off?.("message", onMessage);
      run.child.removeListener?.("message", onMessage);
      if (error) reject(error);
      else resolveMessage();
    };
    const timer = setTimeout(() => {
      finish(new Error(`timed out waiting for capability probe message after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      const payload = unwrapUtilityProcessMessage(message);
      logCapabilityProbeMessage(payload);
      if (
        typeof payload === "object" &&
        payload !== null &&
        (payload as { type?: unknown }).type === "cap-probe-fail"
      ) {
        finish(new Error(String((payload as { error?: unknown }).error ?? "capability probe failed")));
        return;
      }
      if (matches(payload)) finish();
    };

    run.child.on?.("message", onMessage);
    run.exit.then((exit) => {
      finish(new Error(`capability probe exited early: code=${String(exit.code)} signal=${exit.signal ?? "n/a"}`));
    }).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function unwrapUtilityProcessMessage(message: unknown): unknown {
  if (
    typeof message === "object" &&
    message !== null &&
    "data" in message
  ) {
    return (message as { data: unknown }).data;
  }
  return message;
}

async function waitForCapabilityProbeExit(
  exit: Promise<CapabilityProbeExit>,
  timeoutMs: number,
): Promise<CapabilityProbeExit> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out waiting for capability probe exit after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function assertCapabilityProbeWalNonEmpty(probeDir: string): Promise<number> {
  const walPath = join(probeDir, "capability.sqlite-wal");
  const walStat = await stat(walPath);
  if (walStat.size <= 0) throw new Error(`capability probe WAL file is empty: ${walPath}`);
  return walStat.size;
}

async function forceKillCapabilityProbeChild(pid: number): Promise<string> {
  if (process.platform === "win32") {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true });
    return "taskkill /F";
  }
  process.kill(pid, "SIGKILL");
  return "SIGKILL";
}

type IndexSpikeMode = "option-b" | "option-a-service" | "option-a-writer";
type IndexSpikeRecommendation = "B" | "A\"" | "blocked";

interface IndexSpikeThresholds {
  readonly searchP50Ms: number;
  readonly searchP95Ms: number;
  readonly searchP99Ms: number;
  readonly searchMaxMs: number;
  readonly ownerRssBytes: number;
  readonly ownerUsedHeapToCorpusMax: number;
  readonly ownerUsedHeapBytesSoftMax: number;
  readonly coldFullIndexTargetMs: number;
  readonly coldFullIndexHardMs: number;
}

interface IndexSpikeInit {
  readonly mode: IndexSpikeMode;
  readonly vaultRoot: string;
  readonly dbDir: string;
  readonly chunkBytes: number;
  readonly chunksPerTxn: number;
  readonly query: string;
  readonly writerResetsDb?: boolean;
}

interface IndexSpikeReady {
  readonly type: "index-spike-ready";
  readonly mode: IndexSpikeMode;
  readonly pid: number;
  readonly url?: string;
  readonly port?: number;
  readonly dbPath: string;
}

interface IndexSpikeDone {
  readonly type: "index-spike-done";
  readonly mode: IndexSpikeMode;
  readonly result: IndexSpikeChildResult;
}

interface IndexSpikeFail {
  readonly type: "index-spike-fail";
  readonly error: string;
}

interface IndexSpikeChildResult {
  readonly wallTimeMs: number;
  readonly filesIndexed: number;
  readonly chunksIndexed: number;
  readonly transactions: number;
  readonly totalBytes: number;
  readonly chunkBytes: number;
  readonly chunksPerTxn: number;
  readonly dbPath: string;
  readonly dbBytes: {
    readonly db: number;
    readonly wal: number;
    readonly shm: number;
    readonly total: number;
  };
  readonly owner: {
    readonly current: IndexSpikeMemorySnapshot;
    readonly peak: IndexSpikeMemorySnapshot & { readonly sampledAt: string };
    readonly eventLoopDelay: IndexSpikeEventLoopDelay;
  };
}

interface IndexSpikeMemorySnapshot {
  readonly rss: number;
  readonly external: number;
  readonly arrayBuffers: number;
  readonly heapUsed: number;
  readonly usedHeapSize: number;
}

interface IndexSpikeEventLoopDelay {
  readonly minMs: number;
  readonly meanMs: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

interface IndexSpikeExit {
  readonly code: number | null;
  readonly signal: string | null;
}

interface IndexSpikeRun {
  readonly child: DashboardServiceChild;
  readonly ready: IndexSpikeReady;
  readonly exit: Promise<IndexSpikeExit>;
}

interface IndexSpikeSearchStats {
  readonly count: number;
  readonly errors: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly minMs: number;
}

interface IndexSpikeMeasuredOption {
  readonly label: "B" | "A\"";
  readonly pass: boolean;
  readonly issues: string[];
  readonly search: IndexSpikeSearchStats;
  readonly child: IndexSpikeChildResult;
}

interface IndexGateUtilityRun {
  readonly child: DashboardServiceChild;
  readonly pid: number;
  readonly ready: { readonly url: string; readonly port: number };
  readonly exit: Promise<IndexSpikeExit>;
}

interface IndexGateStatus {
  readonly enabled: boolean;
  readonly dbPath: string;
  readonly schemaVersion: string | null;
  readonly chunkCount: number;
  readonly filesSkipped: number;
  readonly skippedFiles: readonly IndexGateSkippedFile[];
  readonly lastCompleteReconcile: string | null;
  readonly currentState: string;
  readonly lastError: string | null;
  readonly ready: boolean;
}

interface IndexGateSkippedFile {
  readonly relPath: string;
  readonly errorState: string;
  readonly sizeBytes: number | null;
}

interface IndexGateTimedJson {
  readonly status: number;
  readonly latencyMs: number;
  readonly body: Record<string, unknown>;
}

interface IndexGateProcessStats {
  readonly type: "process-stats";
  readonly id?: string;
  readonly role: string;
  readonly stats: {
    readonly current: IndexSpikeMemorySnapshot;
    readonly peak: IndexSpikeMemorySnapshot & { readonly sampledAt: string };
    readonly eventLoopDelay: IndexSpikeEventLoopDelay;
  };
}

interface IndexGateReconcileResult {
  readonly filesIndexed: number;
  readonly filesTombstoned: number;
  readonly chunks: number;
  readonly filesSkipped: number;
}

async function runInstalledIndexGateProbe(): Promise<void> {
  const appPath = app.getAppPath();
  process.env["MEMORY_FORT_APP_PATH"] = appPath;
  process.env["MEMORY_INDEX_SEARCH"] = "1";
  process.env["MEMORY_PROCESS_STATS"] = "1";

  const resultPath = requiredEnv("MEMORY_INDEX_GATE_RESULT_JSON");
  const vaultRoot = requiredEnv("MEMORY_ROOT");
  const indexDbPath = requiredEnv("MEMORY_INDEX_DB_PATH");
  const query = process.env["MEMORY_INDEX_GATE_QUERY"]?.trim() || "needle";
  const corpusBytes = readEnvNumber("MEMORY_INDEX_GATE_CORPUS_BYTES", 0);
  const expectedSkippedFiles = readIndexGateExpectedSkipped();
  const thresholds = readIndexSpikeThresholds();
  const dashboardDistRoot = join(appPath, "dist", "dashboard-ui");
  const servicePath = join(appPath, "dist", "dashboard", "dashboard-service.mjs");
  const writerPath = join(appPath, "dist", "dashboard", "index-writer.mjs");
  const startedAt = new Date().toISOString();
  let service: IndexGateUtilityRun | null = null;
  let writer: IndexGateUtilityRun | null = null;
  let wroteResult = false;

  console.info(`[index-gate main] appPath=${appPath}`);
  console.info(`[index-gate main] vaultRoot=${vaultRoot}`);
  console.info(`[index-gate main] indexDbPath=${indexDbPath}`);

  try {
    await deleteIndexGateDbFiles(indexDbPath);

    service = await forkIndexGateUtility({
      appPath,
      entryPath: servicePath,
      init: {
        vaultRoot,
        dashboardDistRoot,
        runtimeEnv: createMainRuntimeEnv(appPath, servicePath),
      },
    });
    const initialStatus = await fetchIndexGateStatus(service.ready.url);
    const firstSearch = await timedIndexGateSearch(service.ready.url, query);

    const writerStarted = performance.now();
    writer = await forkIndexGateUtility({
      appPath,
      entryPath: writerPath,
      init: {
        vaultRoot,
        dashboardDistRoot,
        runtimeEnv: createMainRuntimeEnv(appPath, writerPath),
        indexDbPath,
        debounceMs: 0,
        intervalMs: 0,
      },
    });

    const reconciled = waitForIndexGateReconciled(writer, 30 * 60_000);
    const statusSamplesPromise = sampleIndexGateStatuses(service.ready.url, reconciled);
    const hammerPromise = hammerIndexGateSearch(service.ready.url, query, reconciled);
    const reconcileResult = await reconciled;
    const coldIndexWallTimeMs = performance.now() - writerStarted;
    const search = await hammerPromise;
    const statusSamples = await statusSamplesPromise;
    const readyStatus = await pollIndexGateReady(service.ready.url, 30_000);
    const finalSearch = await timedIndexGateSearch(service.ready.url, query);
    const [serviceStats, writerStats] = await Promise.all([
      requestIndexGateProcessStats(service, "dashboard-service"),
      requestIndexGateProcessStats(writer, "index-writer"),
    ]);
    const dbBytes = await measureIndexGateDbBytes(indexDbPath);
    const legacyInvocations = await readLegacyCorpusInvocations();

    const issues = evaluateInstalledIndexGate({
      initialStatus,
      readyStatus,
      firstSearch,
      finalSearch,
      search,
      reconcileResult,
      thresholds,
      coldIndexWallTimeMs,
      serviceStats,
      writerStats,
      corpusBytes,
      legacyInvocations,
      expectedSkippedFiles,
    });

    const payload = {
      generatedAt: new Date().toISOString(),
      startedAt,
      pass: issues.length === 0,
      issues,
      runtime: {
        electron: process.versions.electron ?? null,
        node: process.versions.node,
        modules: process.versions.modules,
        platform: process.platform,
        arch: process.arch,
        appPath,
        servicePath,
        writerPath,
        packaged: !(process as NodeJS.Process & { readonly defaultApp?: boolean }).defaultApp,
        memoryIndexSearch: process.env["MEMORY_INDEX_SEARCH"] ?? null,
      },
      thresholds,
      query,
      corpusBytes,
      expectedSkippedFiles,
      status: {
        initial: initialStatus,
        samples: statusSamples,
        ready: readyStatus,
      },
      firstSearch,
      finalSearch,
      reconcile: reconcileResult,
      coldIndexWallTimeMs,
      search,
      dbBytes,
      processes: {
        service: { pid: service.pid, ...serviceStats },
        writer: { pid: writer.pid, ...writerStats },
      },
      legacyLoadSearchCorpusInvocations: legacyInvocations.length,
      legacyLoadSearchCorpusSentinel: process.env["MEMORY_LOAD_SEARCH_CORPUS_SENTINEL"] ?? null,
    };

    await mkdir(resolve(resultPath, ".."), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    wroteResult = true;
    console.info(`[index-gate main] wrote result ${resultPath}`);

    if (issues.length > 0) {
      throw new Error(`installed index gate failed: ${issues.join("; ")}`);
    }
  } catch (error) {
    if (!wroteResult) await writeInstalledIndexGateFailure(resultPath, error);
    throw error;
  } finally {
    writer?.child.postMessage({ type: "shutdown" });
    service?.child.postMessage({ type: "shutdown" });
    await Promise.allSettled([
      ...(writer ? [waitForIndexSpikeExit(writer.exit, 10_000)] : []),
      ...(service ? [waitForIndexSpikeExit(service.exit, 10_000)] : []),
    ]);
  }
}

async function forkIndexGateUtility(opts: {
  readonly appPath: string;
  readonly entryPath: string;
  readonly init: Record<string, unknown>;
}): Promise<IndexGateUtilityRun> {
  const child = forkDashboardUtilityProcess(opts.entryPath, opts.appPath);
  const pid = await waitForCapabilityProbePid(child, 10_000);
  const exit = new Promise<IndexSpikeExit>((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolveExit({ code, signal: signal ?? null });
    });
  });
  const ready = waitForIndexGateReady(child, 30_000);
  child.postMessage(opts.init);
  return { child, pid, ready: await ready, exit };
}

function waitForIndexGateReady(
  child: DashboardServiceChild,
  timeoutMs: number,
): Promise<{ readonly url: string; readonly port: number }> {
  return waitForIndexSpikeMessage(child, timeoutMs, (payload) => {
    if (isIndexWriterError(payload)) throw new Error(payload.error);
    if (!isDashboardReadyMessage(payload)) return null;
    return payload;
  });
}

function waitForIndexGateReconciled(
  run: IndexGateUtilityRun,
  timeoutMs: number,
): Promise<IndexGateReconcileResult> {
  return waitForIndexSpikeMessage(run.child, timeoutMs, (payload) => {
    if (isIndexWriterError(payload)) throw new Error(payload.error);
    if (!isIndexWriterReconciled(payload)) return null;
    return payload.result;
  });
}

async function fetchIndexGateStatus(baseUrl: string): Promise<IndexGateStatus> {
  const response = await fetchIndexGateJson(baseUrl, "/api/index-status");
  return response.body as unknown as IndexGateStatus;
}

async function timedIndexGateSearch(baseUrl: string, query: string): Promise<IndexGateTimedJson> {
  const url = new URL("/api/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "20");
  const started = performance.now();
  const response = await fetchWithTimeout(url, 10_000);
  const body = await response.json() as Record<string, unknown>;
  return {
    status: response.status,
    latencyMs: performance.now() - started,
    body,
  };
}

async function fetchIndexGateJson(baseUrl: string, path: string): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> {
  const response = await fetchWithTimeout(new URL(path, baseUrl), 10_000);
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function sampleIndexGateStatuses(
  baseUrl: string,
  done: Promise<unknown>,
): Promise<IndexGateStatus[]> {
  let stopped = false;
  done.finally(() => {
    stopped = true;
  }).catch(() => {
    stopped = true;
  });
  const samples: IndexGateStatus[] = [];
  while (!stopped) {
    try {
      samples.push(await fetchIndexGateStatus(baseUrl));
    } catch {
      // Search latency is the gate; status samples are evidence only.
    }
    await delayMs(250);
  }
  return samples;
}

async function hammerIndexGateSearch(
  baseUrl: string,
  query: string,
  done: Promise<unknown>,
): Promise<IndexSpikeSearchStats> {
  let stopped = false;
  done.then(
    () => {
      stopped = true;
    },
    () => {
      stopped = true;
    },
  );

  const samples: number[] = [];
  let errors = 0;
  while (!stopped) {
    const url = new URL("/api/search", baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "20");
    const started = performance.now();
    try {
      const response = await fetchWithTimeout(url, 10_000);
      await response.arrayBuffer();
      if (!response.ok) errors += 1;
      samples.push(performance.now() - started);
    } catch {
      errors += 1;
      samples.push(performance.now() - started);
    }
    await delayMs(20);
  }

  return summarizeSearchSamples(samples, errors);
}

async function pollIndexGateReady(baseUrl: string, timeoutMs: number): Promise<IndexGateStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: IndexGateStatus | null = null;
  while (Date.now() < deadline) {
    last = await fetchIndexGateStatus(baseUrl);
    if (last.ready && last.chunkCount > 0) return last;
    await delayMs(250);
  }
  throw new Error(`index did not become ready after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

function requestIndexGateProcessStats(
  run: IndexGateUtilityRun,
  role: "dashboard-service" | "index-writer",
): Promise<Omit<IndexGateProcessStats, "type" | "id">> {
  const id = `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stats = waitForIndexSpikeMessage(run.child, 10_000, (payload) => {
    if (!isIndexGateProcessStats(payload) || payload.id !== id) return null;
    return {
      role: payload.role,
      stats: payload.stats,
    };
  });
  run.child.postMessage({ type: "process-stats", id });
  return stats;
}

async function readLegacyCorpusInvocations(): Promise<string[]> {
  const sentinelPath = process.env["MEMORY_LOAD_SEARCH_CORPUS_SENTINEL"]?.trim();
  if (!sentinelPath) return [];
  try {
    return (await readFile(sentinelPath, "utf8")).split(/\r?\n/u).filter((line) => line.trim().length > 0);
  } catch (error) {
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (code === "ENOENT") return [];
    throw error;
  }
}

function evaluateInstalledIndexGate(input: {
  readonly initialStatus: IndexGateStatus;
  readonly readyStatus: IndexGateStatus;
  readonly firstSearch: IndexGateTimedJson;
  readonly finalSearch: IndexGateTimedJson;
  readonly search: IndexSpikeSearchStats;
  readonly reconcileResult: IndexGateReconcileResult;
  readonly thresholds: IndexSpikeThresholds;
  readonly coldIndexWallTimeMs: number;
  readonly serviceStats: Omit<IndexGateProcessStats, "type" | "id">;
  readonly writerStats: Omit<IndexGateProcessStats, "type" | "id">;
  readonly corpusBytes: number;
  readonly legacyInvocations: readonly string[];
  readonly expectedSkippedFiles: readonly string[];
}): string[] {
  const issues: string[] = [];
  if (input.initialStatus.currentState !== "building" || input.initialStatus.ready) {
    issues.push(`initial /api/index-status was not building: ${JSON.stringify(input.initialStatus)}`);
  }
  if (!input.readyStatus.ready || input.readyStatus.chunkCount <= 0) {
    issues.push(`ready /api/index-status missing chunks: ${JSON.stringify(input.readyStatus)}`);
  }
  if (input.reconcileResult.chunks <= 0) {
    issues.push(`index writer reconciled zero chunks: ${JSON.stringify(input.reconcileResult)}`);
  }
  if (input.firstSearch.status !== 200) {
    issues.push(`first search status ${input.firstSearch.status}`);
  }
  if (input.firstSearch.latencyMs > input.thresholds.searchMaxMs) {
    issues.push(`first search latency ${input.firstSearch.latencyMs.toFixed(1)}ms > ${input.thresholds.searchMaxMs}ms`);
  }
  if (input.finalSearch.status !== 200) {
    issues.push(`final search status ${input.finalSearch.status}`);
  }
  if (!hasIndexSearchHit(input.finalSearch.body)) {
    issues.push("final /api/search did not return an index-backed hit");
  }
  if (input.legacyInvocations.length > 0) {
    issues.push(`legacy loadSearchCorpus invoked ${input.legacyInvocations.length} time(s) in index mode`);
  }
  issues.push(...assertExpectedIndexGateSkips(input.readyStatus, input.reconcileResult, input.expectedSkippedFiles));
  issues.push(...evaluateIndexGateSearchStats(input.search, input.thresholds));
  issues.push(...evaluateIndexGateProcessStats("dashboard-service", input.serviceStats, input.thresholds, input.corpusBytes));
  issues.push(...evaluateIndexGateProcessStats("index-writer", input.writerStats, input.thresholds, input.corpusBytes));
  if (input.coldIndexWallTimeMs > input.thresholds.coldFullIndexTargetMs) {
    const hardSuffix = input.coldIndexWallTimeMs <= input.thresholds.coldFullIndexHardMs
      ? " (within hard cap)"
      : " (over hard cap)";
    issues.push(
      `cold full-index ${input.coldIndexWallTimeMs.toFixed(1)}ms > target ${input.thresholds.coldFullIndexTargetMs}ms${hardSuffix}`,
    );
  }
  return issues;
}

function assertExpectedIndexGateSkips(
  readyStatus: IndexGateStatus,
  reconcileResult: IndexGateReconcileResult,
  expectedSkippedFiles: readonly string[],
): string[] {
  const issues: string[] = [];
  const expected = new Set(expectedSkippedFiles);
  const skipped = new Map(readyStatus.skippedFiles.map((file) => [file.relPath, file]));

  if (readyStatus.filesSkipped !== expected.size) {
    issues.push(`expected ${expected.size} skipped file(s), status reported ${readyStatus.filesSkipped}`);
  }
  if (reconcileResult.filesSkipped !== expected.size) {
    issues.push(`expected ${expected.size} skipped file(s), reconcile reported ${reconcileResult.filesSkipped}`);
  }
  for (const relPath of expected) {
    const skippedFile = skipped.get(relPath);
    if (!skippedFile) {
      issues.push(`expected skipped file missing from /api/index-status: ${relPath}`);
    } else if (skippedFile.errorState !== "too-large") {
      issues.push(`expected skipped file ${relPath} has errorState ${skippedFile.errorState}`);
    }
  }
  const unexpected = readyStatus.skippedFiles
    .map((file) => file.relPath)
    .filter((relPath) => !expected.has(relPath));
  if (unexpected.length > 0) {
    issues.push(`unexpected skipped file(s): ${unexpected.join(", ")}`);
  }

  return issues;
}

function evaluateIndexGateSearchStats(
  search: IndexSpikeSearchStats,
  thresholds: IndexSpikeThresholds,
): string[] {
  const issues: string[] = [];
  if (search.count < 10) issues.push(`search samples too low: ${search.count}`);
  if (search.errors > 0) issues.push(`search errors: ${search.errors}`);
  if (search.p50Ms > thresholds.searchP50Ms) issues.push(`search p50 ${search.p50Ms.toFixed(1)}ms > ${thresholds.searchP50Ms}ms`);
  if (search.p95Ms > thresholds.searchP95Ms) issues.push(`search p95 ${search.p95Ms.toFixed(1)}ms > ${thresholds.searchP95Ms}ms`);
  if (search.p99Ms > thresholds.searchP99Ms) issues.push(`search p99 ${search.p99Ms.toFixed(1)}ms > ${thresholds.searchP99Ms}ms`);
  if (search.maxMs > thresholds.searchMaxMs) issues.push(`search max ${search.maxMs.toFixed(1)}ms > ${thresholds.searchMaxMs}ms`);
  return issues;
}

function evaluateIndexGateProcessStats(
  role: string,
  processStats: Omit<IndexGateProcessStats, "type" | "id">,
  thresholds: IndexSpikeThresholds,
  corpusBytes: number,
): string[] {
  const issues: string[] = [];
  const peak = processStats.stats.peak;
  if (peak.rss > thresholds.ownerRssBytes) {
    issues.push(`${role} peak rss ${peak.rss} > ${thresholds.ownerRssBytes}`);
  }
  const usedHeapRatio = corpusBytes > 0 ? peak.usedHeapSize / corpusBytes : 1;
  if (
    usedHeapRatio > thresholds.ownerUsedHeapToCorpusMax &&
    peak.usedHeapSize > thresholds.ownerUsedHeapBytesSoftMax
  ) {
    issues.push(
      `${role} used_heap ratio ${usedHeapRatio.toFixed(3)} > ${thresholds.ownerUsedHeapToCorpusMax} and used_heap ${peak.usedHeapSize} > ${thresholds.ownerUsedHeapBytesSoftMax}`,
    );
  }
  return issues;
}

function hasIndexSearchHit(body: Record<string, unknown>): boolean {
  const results = Array.isArray(body.results) ? body.results : [];
  return results.some((result) => {
    return (
      typeof result === "object" &&
      result !== null &&
      (result as { source?: unknown }).source === "index"
    );
  });
}

async function measureIndexGateDbBytes(dbPath: string): Promise<{
  readonly db: number;
  readonly wal: number;
  readonly shm: number;
  readonly total: number;
}> {
  const db = await fileSize(dbPath);
  const wal = await fileSize(`${dbPath}-wal`);
  const shm = await fileSize(`${dbPath}-shm`);
  return { db, wal, shm, total: db + wal + shm };
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function deleteIndexGateDbFiles(dbPath: string): Promise<void> {
  await mkdir(resolve(dbPath, ".."), { recursive: true });
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
  ]);
}

async function writeInstalledIndexGateFailure(resultPath: string, error: unknown): Promise<void> {
  await mkdir(resolve(resultPath, ".."), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      pass: false,
      issues: [formatErrorForLog(error)],
    }, null, 2)}\n`,
    "utf8",
  );
}

function isDashboardReadyMessage(payload: unknown): payload is { readonly url: string; readonly port: number } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { url?: unknown }).url === "string" &&
    typeof (payload as { port?: unknown }).port === "number"
  );
}

function isIndexWriterReconciled(payload: unknown): payload is {
  readonly type: "index-writer-reconciled";
  readonly result: IndexGateReconcileResult;
} {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { type?: unknown }).type === "index-writer-reconciled" &&
    typeof (payload as { result?: { chunks?: unknown } }).result?.chunks === "number"
  );
}

function isIndexWriterError(payload: unknown): payload is { readonly type: "index-writer-error"; readonly error: string } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { type?: unknown }).type === "index-writer-error" &&
    typeof (payload as { error?: unknown }).error === "string"
  );
}

function isIndexGateProcessStats(payload: unknown): payload is IndexGateProcessStats {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { type?: unknown }).type === "process-stats" &&
    typeof (payload as { id?: unknown }).id === "string" &&
    typeof (payload as { role?: unknown }).role === "string" &&
    typeof (payload as { stats?: unknown }).stats === "object" &&
    (payload as { stats?: unknown }).stats !== null
  );
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function runIndexConcurrencySpike(): Promise<void> {
  const appPath = app.getAppPath();
  process.env["MEMORY_FORT_APP_PATH"] = appPath;
  const spikePath = join(appPath, "dist", "dashboard", "index-concurrency-spike.mjs");
  const resultPath = requiredEnv("MEMORY_INDEX_SPIKE_RESULT_JSON");
  const vaultRoot = requiredEnv("MEMORY_INDEX_SPIKE_VAULT");
  const dbRoot = requiredEnv("MEMORY_INDEX_SPIKE_DB_ROOT");
  const thresholds = readIndexSpikeThresholds();
  const query = process.env["MEMORY_INDEX_SPIKE_QUERY"]?.trim() || "needle";
  const chunkBytes = readEnvInt("MEMORY_INDEX_SPIKE_CHUNK_BYTES", 64 * 1024);
  const chunksPerTxn = readEnvInt("MEMORY_INDEX_SPIKE_CHUNKS_PER_TXN", 32);
  const startedAt = new Date().toISOString();

  console.info(`[index-spike main] appPath=${appPath}`);
  console.info(`[index-spike main] spikePath=${spikePath}`);
  console.info(`[index-spike main] vaultRoot=${vaultRoot}`);

  const optionB = await runIndexSpikeOptionB({
    appPath,
    spikePath,
    vaultRoot,
    dbRoot,
    query,
    chunkBytes,
    chunksPerTxn,
    thresholds,
  });

  let optionA: IndexSpikeMeasuredOption | null = null;
  let recommendation: IndexSpikeRecommendation = "B";
  if (!optionB.pass) {
    console.info(`[index-spike main] Option B missed thresholds: ${optionB.issues.join("; ")}`);
    optionA = await runIndexSpikeOptionA({
      appPath,
      spikePath,
      vaultRoot,
      dbRoot,
      query,
      chunkBytes,
      chunksPerTxn,
      thresholds,
    });
    recommendation = optionA.pass ? "A\"" : "blocked";
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    startedAt,
    runtime: {
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      modules: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
      appPath,
      spikePath,
      packaged: !(process as NodeJS.Process & { readonly defaultApp?: boolean }).defaultApp,
    },
    thresholds,
    recommendation,
    options: {
      B: optionB,
      ...(optionA ? { "A\"": optionA } : { "A\"": { ran: false, reason: "Option B met thresholds" } }),
    },
  };

  await mkdir(resolve(resultPath, ".."), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.info(`[index-spike main] wrote result ${resultPath}`);

  if (recommendation === "blocked") {
    throw new Error("No D1 option met the spike thresholds");
  }
}

async function runIndexSpikeOptionB(opts: {
  readonly appPath: string;
  readonly spikePath: string;
  readonly vaultRoot: string;
  readonly dbRoot: string;
  readonly query: string;
  readonly chunkBytes: number;
  readonly chunksPerTxn: number;
  readonly thresholds: IndexSpikeThresholds;
}): Promise<IndexSpikeMeasuredOption> {
  const run = await forkIndexSpikeChild({
    appPath: opts.appPath,
    spikePath: opts.spikePath,
    init: {
      mode: "option-b",
      vaultRoot: opts.vaultRoot,
      dbDir: join(opts.dbRoot, "option-b"),
      query: opts.query,
      chunkBytes: opts.chunkBytes,
      chunksPerTxn: opts.chunksPerTxn,
    },
  });
  if (!run.ready.url) throw new Error("Option B did not expose a search URL");
  const done = waitForIndexSpikeDone(run, "option-b", 30 * 60_000);
  const hammer = hammerIndexSpikeSearch(run.ready.url, opts.query, done);
  run.child.postMessage({ type: "start" });
  try {
    const child = await done;
    const search = await hammer;
    run.child.postMessage({ type: "shutdown" });
    const measured = evaluateIndexSpikeOption("B", child, search, opts.thresholds);
    await waitForIndexSpikeExit(run.exit, 30_000);
    return measured;
  } catch (error) {
    try {
      run.child.kill();
    } catch {
      // Preserve the original spike failure.
    }
    throw error;
  }
}

async function runIndexSpikeOptionA(opts: {
  readonly appPath: string;
  readonly spikePath: string;
  readonly vaultRoot: string;
  readonly dbRoot: string;
  readonly query: string;
  readonly chunkBytes: number;
  readonly chunksPerTxn: number;
  readonly thresholds: IndexSpikeThresholds;
}): Promise<IndexSpikeMeasuredOption> {
  const dbDir = join(opts.dbRoot, "option-a2");
  const service = await forkIndexSpikeChild({
    appPath: opts.appPath,
    spikePath: opts.spikePath,
    init: {
      mode: "option-a-service",
      vaultRoot: opts.vaultRoot,
      dbDir,
      query: opts.query,
      chunkBytes: opts.chunkBytes,
      chunksPerTxn: opts.chunksPerTxn,
    },
  });
  if (!service.ready.url) throw new Error("Option A\" service did not expose a search URL");
  const writer = await forkIndexSpikeChild({
    appPath: opts.appPath,
    spikePath: opts.spikePath,
    init: {
      mode: "option-a-writer",
      vaultRoot: opts.vaultRoot,
      dbDir,
      query: opts.query,
      chunkBytes: opts.chunkBytes,
      chunksPerTxn: opts.chunksPerTxn,
    },
  });

  const done = waitForIndexSpikeDone(writer, "option-a-writer", 30 * 60_000);
  const hammer = hammerIndexSpikeSearch(service.ready.url, opts.query, done);
  writer.child.postMessage({ type: "start" });

  try {
    const child = await done;
    const search = await hammer;
    writer.child.postMessage({ type: "shutdown" });
    service.child.postMessage({ type: "shutdown" });
    const measured = evaluateIndexSpikeOption("A\"", child, search, opts.thresholds);
    await Promise.allSettled([
      waitForIndexSpikeExit(writer.exit, 30_000),
      waitForIndexSpikeExit(service.exit, 30_000),
    ]);
    return measured;
  } catch (error) {
    try {
      writer.child.kill();
      service.child.kill();
    } catch {
      // Preserve the original spike failure.
    }
    throw error;
  }
}

async function forkIndexSpikeChild(opts: {
  readonly appPath: string;
  readonly spikePath: string;
  readonly init: IndexSpikeInit;
}): Promise<IndexSpikeRun> {
  const child = forkDashboardUtilityProcess(opts.spikePath, opts.appPath);
  const pid = await waitForCapabilityProbePid(child, 10_000);
  const exit = new Promise<IndexSpikeExit>((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolveExit({ code, signal: signal ?? null });
    });
  });
  const ready = waitForIndexSpikeReady(child, opts.init.mode, 30_000);
  child.postMessage(opts.init);
  return { child, ready: await ready, exit };
}

function waitForIndexSpikeReady(
  child: DashboardServiceChild,
  mode: IndexSpikeMode,
  timeoutMs: number,
): Promise<IndexSpikeReady> {
  return waitForIndexSpikeMessage(child, timeoutMs, (payload) => {
    if (isIndexSpikeFail(payload)) throw new Error(payload.error);
    if (!isIndexSpikeReady(payload) || payload.mode !== mode) return null;
    return payload;
  });
}

function waitForIndexSpikeDone(
  run: IndexSpikeRun,
  mode: IndexSpikeMode,
  timeoutMs: number,
): Promise<IndexSpikeChildResult> {
  return waitForIndexSpikeMessage(run.child, timeoutMs, (payload) => {
    if (isIndexSpikeFail(payload)) throw new Error(payload.error);
    if (!isIndexSpikeDone(payload) || payload.mode !== mode) return null;
    return payload.result;
  });
}

function waitForIndexSpikeMessage<T>(
  child: DashboardServiceChild,
  timeoutMs: number,
  read: (payload: unknown) => T | null,
): Promise<T> {
  return new Promise((resolveMessage, reject) => {
    let settled = false;
    const finish = (value?: T, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.("message", onMessage);
      child.removeListener?.("message", onMessage);
      if (error) reject(error);
      else resolveMessage(value as T);
    };
    const timer = setTimeout(() => {
      finish(undefined, new Error(`timed out waiting for index spike message after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      const payload = unwrapUtilityProcessMessage(message);
      try {
        const value = read(payload);
        if (value) finish(value);
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)));
      }
    };
    child.on?.("message", onMessage);
  });
}

async function hammerIndexSpikeSearch(
  baseUrl: string,
  query: string,
  done: Promise<unknown>,
): Promise<IndexSpikeSearchStats> {
  let stopped = false;
  done.then(
    () => {
      stopped = true;
    },
    () => {
      stopped = true;
    },
  );

  const samples: number[] = [];
  let errors = 0;
  while (!stopped) {
    const url = new URL("/api/search", baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "20");
    const started = performance.now();
    try {
      const response = await fetchWithTimeout(url, 10_000);
      await response.arrayBuffer();
      if (!response.ok) errors += 1;
      samples.push(performance.now() - started);
    } catch {
      errors += 1;
      samples.push(performance.now() - started);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }

  return summarizeSearchSamples(samples, errors);
}

async function fetchWithTimeout(url: URL, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function summarizeSearchSamples(samples: readonly number[], errors: number): IndexSpikeSearchStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    errors,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

function evaluateIndexSpikeOption(
  label: "B" | "A\"",
  child: IndexSpikeChildResult,
  search: IndexSpikeSearchStats,
  thresholds: IndexSpikeThresholds,
): IndexSpikeMeasuredOption {
  const issues: string[] = [];
  if (search.count < 10) issues.push(`search samples too low: ${search.count}`);
  if (search.errors > 0) issues.push(`search errors: ${search.errors}`);
  if (search.p50Ms > thresholds.searchP50Ms) issues.push(`search p50 ${search.p50Ms.toFixed(1)}ms > ${thresholds.searchP50Ms}ms`);
  if (search.p95Ms > thresholds.searchP95Ms) issues.push(`search p95 ${search.p95Ms.toFixed(1)}ms > ${thresholds.searchP95Ms}ms`);
  if (search.p99Ms > thresholds.searchP99Ms) issues.push(`search p99 ${search.p99Ms.toFixed(1)}ms > ${thresholds.searchP99Ms}ms`);
  if (search.maxMs > thresholds.searchMaxMs) issues.push(`search max ${search.maxMs.toFixed(1)}ms > ${thresholds.searchMaxMs}ms`);
  if (child.owner.peak.rss > thresholds.ownerRssBytes) {
    issues.push(`owner peak rss ${child.owner.peak.rss} > ${thresholds.ownerRssBytes}`);
  }
  const usedHeapRatio = child.totalBytes > 0 ? child.owner.peak.usedHeapSize / child.totalBytes : 1;
  if (
    usedHeapRatio > thresholds.ownerUsedHeapToCorpusMax &&
    child.owner.peak.usedHeapSize > thresholds.ownerUsedHeapBytesSoftMax
  ) {
    issues.push(
      `owner used_heap ratio ${usedHeapRatio.toFixed(3)} > ${thresholds.ownerUsedHeapToCorpusMax} and used_heap ${child.owner.peak.usedHeapSize} > ${thresholds.ownerUsedHeapBytesSoftMax}`,
    );
  }
  if (child.wallTimeMs > thresholds.coldFullIndexTargetMs) {
    const hardSuffix = child.wallTimeMs <= thresholds.coldFullIndexHardMs ? " (within hard cap)" : " (over hard cap)";
    issues.push(`cold full-index ${child.wallTimeMs.toFixed(1)}ms > target ${thresholds.coldFullIndexTargetMs}ms${hardSuffix}`);
  }

  return { label, pass: issues.length === 0, issues, search, child };
}

function isIndexSpikeReady(payload: unknown): payload is IndexSpikeReady {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { type?: unknown }).type === "index-spike-ready" &&
    typeof (payload as { pid?: unknown }).pid === "number" &&
    typeof (payload as { dbPath?: unknown }).dbPath === "string"
  );
}

function isIndexSpikeDone(payload: unknown): payload is IndexSpikeDone {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { type?: unknown }).type === "index-spike-done" &&
    typeof (payload as { result?: unknown }).result === "object" &&
    (payload as { result?: unknown }).result !== null
  );
}

function isIndexSpikeFail(payload: unknown): payload is IndexSpikeFail {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { type?: unknown }).type === "index-spike-fail" &&
    typeof (payload as { error?: unknown }).error === "string"
  );
}

async function waitForIndexSpikeExit(
  exit: Promise<IndexSpikeExit>,
  timeoutMs: number,
): Promise<IndexSpikeExit> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out waiting for index spike exit after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function readIndexSpikeThresholds(): IndexSpikeThresholds {
  return {
    // Latency thresholds = search responsiveness DURING an active full reconcile.
    // Calibrated CI-realistic: a full ~750 MB cold-index on a constrained 2-core
    // shared runner (esp. macOS) genuinely competes with the read service, so the
    // worst-case during-reindex search is degraded-but-usable, not broken. The HARD
    // gate is memory-bounded (ownerRss + used_heap/corpus below) — that's the OOM
    // proof and is unchanged. Strict-fast hardware stays well under these.
    // Measured worst-case during a full 750 MB reindex on the slowest CI runner
    // (Linux AppImage/xvfb p95 ~2.06 s, macOS ~1.26 s); set with generous margin
    // above that so CI variance doesn't flake. Memory-bounded stays the HARD gate.
    searchP50Ms: readEnvNumber("MEMORY_INDEX_SPIKE_SEARCH_P50_MS", 500),
    searchP95Ms: readEnvNumber("MEMORY_INDEX_SPIKE_SEARCH_P95_MS", 3_500),
    searchP99Ms: readEnvNumber("MEMORY_INDEX_SPIKE_SEARCH_P99_MS", 5_000),
    searchMaxMs: readEnvNumber("MEMORY_INDEX_SPIKE_SEARCH_MAX_MS", 8_000),
    ownerRssBytes: readEnvNumber("MEMORY_INDEX_SPIKE_OWNER_RSS_BYTES", 1.5 * 1024 * 1024 * 1024),
    ownerUsedHeapToCorpusMax: readEnvNumber("MEMORY_INDEX_SPIKE_USED_HEAP_CORPUS_RATIO", 0.25),
    ownerUsedHeapBytesSoftMax: readEnvNumber("MEMORY_INDEX_SPIKE_USED_HEAP_SOFT_MAX_BYTES", 512 * 1024 * 1024),
    coldFullIndexTargetMs: readEnvNumber("MEMORY_INDEX_SPIKE_COLD_TARGET_MS", 10 * 60_000),
    coldFullIndexHardMs: readEnvNumber("MEMORY_INDEX_SPIKE_COLD_HARD_MS", 20 * 60_000),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readEnvInt(name: string, fallback: number): number {
  return Math.trunc(readEnvNumber(name, fallback));
}

function readEnvNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readIndexGateExpectedSkipped(): string[] {
  const raw = process.env["MEMORY_INDEX_GATE_EXPECTED_SKIPPED"]?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`MEMORY_INDEX_GATE_EXPECTED_SKIPPED must be JSON: ${raw}`, { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error("MEMORY_INDEX_GATE_EXPECTED_SKIPPED must be a JSON string array");
  }
  return [...new Set(parsed)].sort();
}

async function writeIndexSpikeFailure(error: unknown): Promise<void> {
  const resultPath = process.env["MEMORY_INDEX_SPIKE_RESULT_JSON"]?.trim();
  if (!resultPath) return;
  await mkdir(resolve(resultPath, ".."), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      recommendation: "blocked",
      error: formatErrorForLog(error),
    }, null, 2)}\n`,
    "utf8",
  );
}

async function logCapabilityProbeTransition(probeDir: string, line: string): Promise<void> {
  const entry = `[${new Date().toISOString()}] parent ${line}`;
  await appendFile(join(probeDir, "cap-probe.log"), `${entry}\n`, "utf8");
  console.info(`[cap-probe main] ${line}`);
}

async function runCapabilityTest(): Promise<void> {
  console.info(
    `[cap-test] electron=${process.versions.electron ?? "unknown"} node=${process.versions.node} modules=${
      process.versions.modules
    } arch=${process.arch}`
  );

  const { assertFts5, assertVec0Knn, closeCapabilityDb, loadSqliteVec, openCapabilityDb } = await import(
    "../src/index/native/capability.js"
  );
  let db: ReturnType<typeof openCapabilityDb>;
  try {
    db = openCapabilityDb(":memory:");
  } catch (error) {
    console.error(`[cap-test] CAP_FTS5 FAIL ${formatErrorForLog(error)}`);
    throw error;
  }

  try {
    runCapabilityProbe("CAP_FTS5", () => assertFts5(db));
    runCapabilityProbe("CAP_VEC_KNN", () => {
      loadSqliteVec(db);
      assertVec0Knn(db);
    });
  } finally {
    closeCapabilityDb(db);
  }
}

function runCapabilityProbe(label: "CAP_FTS5" | "CAP_VEC_KNN", probe: () => void): void {
  try {
    probe();
  } catch (error) {
    console.error(`[cap-test] ${label} FAIL ${formatErrorForLog(error)}`);
    throw error;
  }

  console.info(`[cap-test] ${label} ok`);
}

function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    const step = getErrorStep(error);
    const summary = step ? `${error.name} step=${step}: ${error.message}` : `${error.name}: ${error.message}`;
    if (!error.stack) return summary;
    return step ? `${summary}\n${error.stack}` : error.stack;
  }
  return String(error);
}

function getErrorStep(error: Error): string | null {
  const step = (error as { readonly step?: unknown }).step;
  return typeof step === "string" ? step : null;
}

// Surface the existing window when the user launches a second instance
// (e.g. clicking the Start-menu shortcut while the app is already running,
// as it is right after the installer's runAfterFinish auto-launch). A plain
// focus() from a background process does not reliably come to the foreground
// on Windows, so also un-minimize, show, raise, and toggle always-on-top to
// bypass the foreground lock.
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.setAlwaysOnTop(false);
  }
});

app
  .whenReady()
  .then(async () => {
    if (isIndexGateProbe) {
      try {
        await runInstalledIndexGateProbe();
        app.exit(0);
      } catch (error) {
        console.error(`[index-gate main] FAIL ${formatErrorForLog(error)}`);
        app.exit(1);
      }
      return;
    }
    if (isIndexConcurrencySpike) {
      try {
        await runIndexConcurrencySpike();
        app.exit(0);
      } catch (error) {
        console.error(`[index-spike main] FAIL ${formatErrorForLog(error)}`);
        await writeIndexSpikeFailure(error);
        app.exit(1);
      }
      return;
    }
    if (isCapabilityProbe) {
      try {
        await runInstalledCapabilityProbe();
        app.exit(0);
      } catch (error) {
        console.error(`[cap-probe main] FAIL ${formatErrorForLog(error)}`);
        app.exit(1);
      }
      return;
    }
    if (isCapabilityTest) {
      try {
        await runCapabilityTest();
        app.exit(0);
      } catch {
        app.exit(1);
      }
      return;
    }
    await createWindow();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

app.on("before-quit", () => {
  indexWriterSupervisor?.stop();
  indexWriterSupervisor = null;
  dashboardSupervisor?.stop();
  dashboardSupervisor = null;
});

app.on("window-all-closed", () => {
  indexWriterSupervisor?.stop();
  indexWriterSupervisor = null;
  dashboardSupervisor?.stop();
  dashboardSupervisor = null;
  app.quit();
});
