import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { runDashboard, type DashboardRun } from "../src/cli/commands/dashboard.js";

// main heap is ~4GB-capped; heavy work runs in child workers.

// Prevent two MemoryFort windows competing on port 4410
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let dashboard: DashboardRun | null = null;
let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  dashboard = await runDashboard({
    noOpen: true,
    dashboardDistRoot: join(app.getAppPath(), "dist", "dashboard-ui"),
  });

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

app.on("window-all-closed", () => {
  void dashboard?.close().then(() => app.quit());
});
