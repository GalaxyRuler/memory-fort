import { app, BrowserWindow, shell, utilityProcess } from "electron";
import { join } from "node:path";
import {
  createDashboardServiceSupervisor,
  type DashboardServiceSupervisor,
  type DashboardServiceChild,
  type DashboardServiceMainRuntimeEnv,
  type DashboardServiceRuntimeEnv,
} from "../src/dashboard/dashboard-service-supervisor.js";

// main heap is ~4GB-capped; dashboard server work runs in a utility process.

// Prevent two MemoryFort windows competing on port 4410
const isCapabilityTest = process.env["MEMORY_CAP_TEST"] === "1";
const isCapabilityProbe = process.env["MEMORY_CAP_PROBE"] === "1";
const gotLock = isCapabilityTest || isCapabilityProbe || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let dashboardSupervisor: DashboardServiceSupervisor | null = null;
let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  const appPath = app.getAppPath();
  const dashboardDistRoot = join(appPath, "dist", "dashboard-ui");
  const dashboardServicePath = join(appPath, "dist", "dashboard", "dashboard-service.mjs");
  const runtimeEnv = createMainRuntimeEnv(appPath, dashboardServicePath);
  console.info(`[memory-fort runtime main] ${JSON.stringify(runtimeEnv)}`);
  dashboardSupervisor = createDashboardServiceSupervisor({
    servicePath: dashboardServicePath,
    vaultRoot: process.env["MEMORY_ROOT"] ?? join(app.getPath("home"), ".memory"),
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

async function runInstalledCapabilityProbe(): Promise<void> {
  const appPath = app.getAppPath();
  process.env["MEMORY_FORT_APP_PATH"] = appPath;
  const dashboardDistRoot = join(appPath, "dist", "dashboard-ui");
  const probePath = join(appPath, "dist", "index", "native", "capability-probe.mjs");
  const runtimeEnv = createMainRuntimeEnv(appPath, probePath);
  console.info(`[cap-probe main] ${JSON.stringify(runtimeEnv)}`);
  const supervisor = createDashboardServiceSupervisor({
    servicePath: probePath,
    vaultRoot: process.env["MEMORY_ROOT"] ?? join(app.getPath("temp"), "Memory Fort cap probe vault Ω"),
    dashboardDistRoot,
    fork: (servicePath) => forkDashboardUtilityProcess(servicePath, appPath),
    runtimeEnv,
    maxRestarts: 0,
    onRuntimeEnv: logUtilityRuntimeEnv,
    onMessage: logCapabilityProbeMessage,
  });
  await supervisor.start();
  supervisor.stop();
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
  dashboardSupervisor?.stop();
  dashboardSupervisor = null;
});

app.on("window-all-closed", () => {
  dashboardSupervisor?.stop();
  dashboardSupervisor = null;
  app.quit();
});
