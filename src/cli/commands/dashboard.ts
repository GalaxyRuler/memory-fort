import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { memoryRoot as defaultMemoryRoot } from "../../storage/paths.js";
import {
  createServer,
  type RunningServer,
  type ServerOptions,
} from "../../dashboard/server.js";

export interface DashboardOptions {
  port?: number;
  host?: string;
  noOpen?: boolean;
  vaultRoot?: string;
  dashboardDistRoot?: string;
  createServer?: (opts: ServerOptions) => Promise<RunningServer>;
  openBrowser?: (url: string) => Promise<void>;
  stdout?: (line: string) => void;
}

export interface DashboardRun {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4410;
const PORT_FALLBACK_ATTEMPTS = 10;

export async function runDashboard(opts: DashboardOptions = {}): Promise<DashboardRun> {
  const host = opts.host ?? DEFAULT_HOST;
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const distRoot = opts.dashboardDistRoot ?? defaultDashboardDistRoot();
  const indexHtml = join(distRoot, "index.html");
  // Only enforce the real dist when using the real server. An injected
  // createServer (tests) brings its own server and manages its own assets, so
  // the check must not depend on the repo's on-disk dist/dashboard-ui state.
  if (!opts.createServer && !existsSync(indexHtml)) {
    throw new Error(
      `dashboard UI dist missing index.html at ${indexHtml}; run \`npm run build:ui\` first`,
    );
  }
  const server = await startDashboardServer({
    createServerImpl: opts.createServer ?? createServer,
    vaultRoot: opts.vaultRoot ?? defaultMemoryRoot(),
    dashboardDistRoot: distRoot,
    host,
    port: requestedPort,
  });
  const url = `http://${server.host}:${server.port}/memory/`;
  const writeLine = opts.stdout ?? ((line) => console.log(line));
  writeLine(`Memory dashboard: ${url}`);

  if (opts.noOpen !== true) {
    await (opts.openBrowser ?? openBrowser)(url);
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    process.off("SIGINT", handleShutdown);
    process.off("SIGTERM", handleShutdown);
    await server.close();
  };
  const handleShutdown = () => {
    void close().finally(() => process.exit(0));
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);

  return {
    url,
    host: server.host,
    port: server.port,
    close,
  };
}

export function registerDashboardCommand(program: Command): void {
  program
    .command("dashboard")
    .description("Serve the local dashboard against the writable local memory vault")
    .option("--port <n>", "dashboard port (default: 4410)", parsePort)
    .option("--host <h>", "dashboard host (default: 127.0.0.1)")
    .option("--no-open", "print the URL without opening a browser")
    .action(async (opts: { port?: number; host?: string; open?: boolean }) => {
      try {
        await runDashboard({
          port: opts.port,
          host: opts.host,
          noOpen: opts.open === false,
        });
      } catch (err) {
        console.error(`memory dashboard failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

async function startDashboardServer(opts: {
  createServerImpl: (serverOpts: ServerOptions) => Promise<RunningServer>;
  vaultRoot: string;
  dashboardDistRoot: string;
  host: string;
  port: number;
}): Promise<RunningServer> {
  const maxAttempts = opts.port === 0 ? 1 : PORT_FALLBACK_ATTEMPTS;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = opts.port === 0 ? 0 : opts.port + attempt;
    try {
      return await opts.createServerImpl({
        vaultRoot: opts.vaultRoot,
        dashboardDistRoot: opts.dashboardDistRoot,
        host: opts.host,
        port,
      });
    } catch (err) {
      lastError = err;
      if (!isAddrInUse(err) || opts.port === 0) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function defaultDashboardDistRoot(): string {
  const modulePath = fileURLToPath(import.meta.url).replace(/\\/g, "/");
  if (modulePath.includes("/src/cli/commands/")) {
    return resolve(process.cwd(), "dist", "dashboard-ui");
  }
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "dashboard-ui");
}

function openBrowser(url: string): Promise<void> {
  const child = process.platform === "win32"
    ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
    : process.platform === "darwin"
      ? spawn("open", [url], { detached: true, stdio: "ignore" })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
  return Promise.resolve();
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  return port;
}

function isAddrInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}
