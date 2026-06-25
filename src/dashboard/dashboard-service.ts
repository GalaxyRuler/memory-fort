import { runDashboard, type DashboardOptions, type DashboardRun } from "../cli/commands/dashboard.js";

export interface DashboardServiceInit {
  vaultRoot: string;
  dashboardDistRoot: string;
}

export interface DashboardServiceReady {
  url: string;
  port: number;
}

export interface DashboardServiceParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
}

export interface DashboardServiceOptions {
  parentPort: DashboardServiceParentPort;
  runDashboardImpl?: (opts: DashboardOptions) => Promise<DashboardRun>;
  exit?: (code: number) => void;
}

export function startDashboardService(opts: DashboardServiceOptions): Promise<DashboardServiceReady> {
  const runDashboardImpl = opts.runDashboardImpl ?? runDashboard;
  const exit = opts.exit ?? ((code) => process.exit(code));
  let dashboard: DashboardRun | null = null;
  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await dashboard?.close();
    exit(0);
  }

  async function start(init: DashboardServiceInit): Promise<DashboardServiceReady> {
    dashboard = await runDashboardImpl({
      noOpen: true,
      vaultRoot: init.vaultRoot,
      dashboardDistRoot: init.dashboardDistRoot,
    });
    const ready = { url: dashboard.url, port: dashboard.port };
    opts.parentPort.postMessage(ready);
    return ready;
  }

  const ready = new Promise<DashboardServiceReady>((resolve, reject) => {
    opts.parentPort.on("message", (message) => {
      const payload = unwrapParentPortMessage(message);
      if (isShutdownMessage(payload)) {
        void shutdown().catch(reject);
        return;
      }
      if (!isInitMessage(payload)) {
        reject(new Error("dashboard service expected initial vaultRoot and dashboardDistRoot message"));
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

function isInitMessage(message: unknown): message is DashboardServiceInit {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { vaultRoot?: unknown }).vaultRoot === "string" &&
    typeof (message as { dashboardDistRoot?: unknown }).dashboardDistRoot === "string"
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

declare global {
  namespace NodeJS {
    interface Process {
      parentPort?: DashboardServiceParentPort;
    }
  }
}

if (process.argv[1]?.endsWith("dashboard-service.mjs")) {
  const parentPort = process.parentPort;
  if (!parentPort) {
    console.error("[dashboard-service] missing Electron parentPort");
    process.exit(1);
  }
  startDashboardService({ parentPort }).catch((error: unknown) => {
    console.error(`[dashboard-service] ${(error as Error)?.message ?? String(error)}`);
    process.exit(1);
  });
}
