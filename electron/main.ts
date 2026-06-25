import { app, BrowserWindow, shell, utilityProcess } from "electron";
import { join } from "node:path";
import {
  createDashboardServiceSupervisor,
  type DashboardServiceSupervisor,
  type DashboardServiceChild,
} from "../src/dashboard/dashboard-service-supervisor.js";

// main heap is ~4GB-capped; dashboard server work runs in a utility process.

// Prevent two MemoryFort windows competing on port 4410
const gotLock = app.requestSingleInstanceLock();
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
  dashboardSupervisor = createDashboardServiceSupervisor({
    servicePath: dashboardServicePath,
    vaultRoot: process.env["MEMORY_ROOT"] ?? join(app.getPath("home"), ".memory"),
    dashboardDistRoot,
    fork: (servicePath) => utilityProcess.fork(servicePath) as unknown as DashboardServiceChild,
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

app.whenReady().then(createWindow).catch(console.error);

app.on("before-quit", () => {
  dashboardSupervisor?.stop();
  dashboardSupervisor = null;
});

app.on("window-all-closed", () => {
  dashboardSupervisor?.stop();
  dashboardSupervisor = null;
  app.quit();
});
