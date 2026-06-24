import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runDashboard, type DashboardRun } from "../src/cli/commands/dashboard.js";

// The dashboard backend runs in THIS (main) process and loads the local vault.
// A large vault (raw/ can reach hundreds of MB) pushed V8's default old-space
// past its limit, OOM-killing the app a few seconds after launch ("opens then
// crashes"). Raise the main-process heap so large vaults load. This is a
// stopgap — the loaders should also be bounded so they never read all of raw/
// into memory at once (tracked separately). setFlagsFromString adjusts the
// already-initialised main-process heap; the command-line switch covers any
// child V8 instances.
setFlagsFromString("--max-old-space-size=8192");
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=8192");

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
