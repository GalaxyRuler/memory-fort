import { appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDashboard, type DashboardOptions, type DashboardRun } from "../cli/commands/dashboard.js";
import {
  createProcessStatsMonitor,
  createProcessStatsResponse,
  isProcessStatsRequest,
} from "./process-stats.js";
import type { DashboardServiceRuntimeEnv } from "./dashboard-service-supervisor.js";

export interface DashboardServiceInit {
  vaultRoot: string;
  dashboardDistRoot: string;
  runtimeEnv?: DashboardServiceRuntimeEnv;
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
  const processStats = createProcessStatsMonitor();
  let dashboard: DashboardRun | null = null;
  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    processStats.close();
    await dashboard?.close();
    exit(0);
  }

  async function start(init: DashboardServiceInit): Promise<DashboardServiceReady> {
    try {
      await appendDashboardServiceRuntimeLog(init);
      dashboard = await runDashboardImpl({
        noOpen: true,
        vaultRoot: init.vaultRoot,
        dashboardDistRoot: init.dashboardDistRoot,
      });
      const ready = { url: dashboard.url, port: dashboard.port };
      opts.parentPort.postMessage(ready);
      return ready;
    } catch (error) {
      await appendDashboardServiceLog(init.vaultRoot, error);
      throw error;
    }
  }

  const ready = new Promise<DashboardServiceReady>((resolve, reject) => {
    opts.parentPort.on("message", (message) => {
      const payload = unwrapParentPortMessage(message);
      if (isShutdownMessage(payload)) {
        void shutdown().catch(reject);
        return;
      }
      if (isProcessStatsRequest(payload)) {
        opts.parentPort.postMessage(createProcessStatsResponse("dashboard-service", payload, processStats.snapshot()));
        return;
      }
      if (!isInitMessage(payload)) {
        const error = new Error("dashboard service expected initial vaultRoot and dashboardDistRoot message");
        void appendDashboardServiceLog(undefined, error);
        reject(error);
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

async function appendDashboardServiceLog(vaultRoot: string | undefined, error: unknown): Promise<void> {
  await appendDashboardServiceLogLine(vaultRoot, formatErrorForLog(error));
}

async function appendDashboardServiceRuntimeLog(init: DashboardServiceInit): Promise<void> {
  await appendDashboardServiceLogLine(init.vaultRoot, `runtime ${JSON.stringify({
    main: init.runtimeEnv ?? null,
    child: {
      electron: process.versions.electron ?? null,
      node: process.versions.node,
      modules: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
      childPid: process.pid,
      parentPid: process.ppid,
      serviceEntryPath: process.argv[1] ?? null,
      parentPortPresent: Boolean(process.parentPort),
    },
  })}`);
}

async function appendDashboardServiceLogLine(vaultRoot: string | undefined, line: string): Promise<void> {
  try {
    const logPath = vaultRoot
      ? join(vaultRoot, "logs", "dashboard-service.log")
      : join(tmpdir(), "dashboard-service.log");
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    // Best-effort diagnostic logging must not change service behavior.
  }
}

function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

declare global {
  namespace NodeJS {
    interface Process {
      parentPort?: DashboardServiceParentPort;
    }
  }
}

if (process.parentPort) {
  const parentPort = process.parentPort;
  startDashboardService({ parentPort }).catch(async (error: unknown) => {
    await appendDashboardServiceLog(undefined, error);
    console.error(`[dashboard-service] ${(error as Error)?.message ?? String(error)}`);
    process.exit(1);
  });
}
