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
  buildDashboardUi?: (opts: DashboardUiBuildOptions) => Promise<void>;
  createServer?: (opts: ServerOptions) => Promise<RunningServer>;
  openBrowser?: (url: string) => Promise<void>;
  stdout?: (line: string) => void;
}

export interface DashboardUiBuildOptions {
  repoRoot: string;
  dashboardDistRoot: string;
  indexHtml: string;
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
  const vaultRoot = opts.vaultRoot ?? defaultMemoryRoot();
  const indexHtml = join(distRoot, "index.html");
  const writeLine = opts.stdout ?? ((line) => console.log(line));
  // Only enforce the real dist when using the real server. An injected
  // createServer (tests) brings its own server and manages its own assets, so
  // the check must not depend on the repo's on-disk dist/dashboard-ui state
  // unless a test explicitly injects a dashboard UI builder.
  if ((!opts.createServer || opts.buildDashboardUi) && !existsSync(indexHtml)) {
    const builder = opts.buildDashboardUi ?? (
      opts.dashboardDistRoot ? undefined : defaultDashboardUiBuilder()
    );
    if (builder) {
      writeLine(`building dashboard UI (${indexHtml} missing)...`);
      try {
        await builder({
          repoRoot: findDashboardSourceRoot(process.cwd()) ?? process.cwd(),
          dashboardDistRoot: distRoot,
          indexHtml,
        });
      } catch {
        throw missingDashboardDistError(indexHtml);
      }
    }
    if (!existsSync(indexHtml)) {
      throw missingDashboardDistError(indexHtml);
    }
  }
  const server = await startDashboardServer({
    createServerImpl: opts.createServer ?? createServer,
    vaultRoot,
    dashboardDistRoot: distRoot,
    host,
    port: requestedPort,
  });
  const url = `http://${server.host}:${server.port}/memory/`;
  writeLine(`Memory dashboard: ${url}`);
  writeLine(`Vault root: ${vaultRoot}`);

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
    .option("--root <path>", "memory vault root (default: MEMORY_ROOT or ~/.memory)")
    .option("--no-open", "print the URL without opening a browser")
    .action(async (opts: { port?: number; host?: string; root?: string; open?: boolean }) => {
      try {
        await runDashboard({
          port: opts.port,
          host: opts.host,
          vaultRoot: opts.root ? resolve(opts.root) : undefined,
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

function defaultDashboardUiBuilder(): ((opts: DashboardUiBuildOptions) => Promise<void>) | undefined {
  const repoRoot = findDashboardSourceRoot(process.cwd());
  if (!repoRoot) return undefined;
  return () => runNpmBuildUi(repoRoot);
}

function findDashboardSourceRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (
      existsSync(join(dir, "package.json")) &&
      existsSync(join(dir, "vite.config.ts")) &&
      existsSync(join(dir, "src", "dashboard-ui", "index.html"))
    ) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function runNpmBuildUi(repoRoot: string): Promise<void> {
  return new Promise((resolveBuild, rejectBuild) => {
    const command = process.platform === "win32" ? "cmd.exe" : "npm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "npm run build:ui"]
      : ["run", "build:ui"];
    const child = spawn(
      command,
      args,
      { cwd: repoRoot, stdio: "inherit", windowsHide: true },
    );
    child.once("error", rejectBuild);
    child.once("exit", (code) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`npm run build:ui exited with code ${code ?? "unknown"}`));
    });
  });
}

function missingDashboardDistError(indexHtml: string): Error {
  return new Error(
    `dashboard UI dist missing index.html at ${indexHtml}; run \`npm run build:ui\` first`,
  );
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
