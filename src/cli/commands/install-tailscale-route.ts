import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { configPath } from "../../storage/paths.js";
import { makeRealCommandRunner, type CommandRunner } from "../../sync/git-remote.js";
import { makeRealSshRunner, type SshRunner } from "../../sync/ssh-runner.js";

export interface InstallTailscaleRouteOptions {
  sshHost?: string;
  dashboardPort?: number;
  pathPrefix?: string;
  dryRun?: boolean;
  sshRunner?: SshRunner;
  commandRunner?: CommandRunner;
}

export interface TailscaleRoute {
  host: string;
  path: string;
  target: string;
}

export interface InstallTailscaleRouteResult {
  host: string;
  pathPrefix: string;
  dashboardPort: number;
  preExistingRoutes: TailscaleRoute[];
  postRoutes: TailscaleRoute[];
  alreadyConfigured: boolean;
  serveCommand: string;
  reachabilityVps: boolean;
  reachabilityLocal: boolean;
}

const DEFAULT_HOST = "srv1317946";
const DEFAULT_DASHBOARD_PORT = 4410;
const DEFAULT_PATH_PREFIX = "/memory";
const DEFAULT_MAGIC_DNS_SUFFIX = "tail6916d8.ts.net";
const ROOT_TARGET = "http://127.0.0.1:18789";
const HIGH_PORT_TARGET = "http://127.0.0.1:5678";

async function readConfiguredHost(): Promise<string | null> {
  const path = configPath();
  if (!existsSync(path)) return null;
  const content = await readFile(path, "utf-8");
  const lines = content.split(/\r?\n/);
  let inVpsBlock = false;
  for (const line of lines) {
    if (/^vps:\s*(?:#.*)?$/.test(line)) {
      inVpsBlock = true;
      continue;
    }
    if (inVpsBlock && /^\S/.test(line)) break;
    if (!inVpsBlock) continue;
    const host = /^[ \t]+host:\s*["']?([^"'\r\n#]+)["']?/.exec(line)?.[1]?.trim();
    if (host && host.length > 0) return host;
  }
  return null;
}

function normalizePathPrefix(pathPrefix: string): string {
  const withSlash = pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

function normalizeRoutePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function buildServeCommand(pathPrefix: string, dashboardPort: number): string {
  return `tailscale serve --bg --https=443 --set-path=${pathPrefix} http://127.0.0.1:${dashboardPort}`;
}

async function runSsh(host: string, runner: SshRunner, command: string, description: string, allowNonZeroExit = false) {
  const result = await runner.run(host, { command, description, allowNonZeroExit });
  if (result.exitCode !== 0 && !allowNonZeroExit) {
    throw new Error(`${description} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
  }
  return result;
}

function parseRoutes(json: string): TailscaleRoute[] {
  const parsed = JSON.parse(json) as {
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  };
  const routes: TailscaleRoute[] = [];
  for (const [host, entry] of Object.entries(parsed.Web ?? {})) {
    for (const [path, handler] of Object.entries(entry.Handlers ?? {})) {
      if (typeof handler.Proxy === "string") {
        routes.push({ host, path: normalizeRoutePath(path), target: handler.Proxy });
      }
    }
  }
  return routes.sort((a, b) => `${a.host}${a.path}`.localeCompare(`${b.host}${b.path}`));
}

function hasRoute(routes: TailscaleRoute[], hostSuffix: string, path: string, target: string): boolean {
  const normalized = normalizeRoutePath(path);
  return routes.some((route) =>
    route.host.endsWith(hostSuffix) &&
    normalizeRoutePath(route.path) === normalized &&
    route.target === target,
  );
}

function findPathRoute(routes: TailscaleRoute[], pathPrefix: string): TailscaleRoute | null {
  return routes.find((route) => normalizeRoutePath(route.path) === pathPrefix) ?? null;
}

function assertExpectedBaseRoutes(routes: TailscaleRoute[]): void {
  if (!hasRoute(routes, ":443", "/", ROOT_TARGET)) {
    throw new Error(`expected root route / -> ${ROOT_TARGET}; refusing to modify Tailscale Serve`);
  }
  if (!hasRoute(routes, ":8443", "/", HIGH_PORT_TARGET)) {
    throw new Error(`expected :8443 route / -> ${HIGH_PORT_TARGET}; refusing to modify Tailscale Serve`);
  }
}

function magicDnsHost(sshHost: string, routes: TailscaleRoute[]): string {
  const rootHost = routes.find((route) => route.host.endsWith(":443"))?.host.replace(/:443$/, "");
  if (rootHost) return rootHost;
  if (sshHost.includes(".")) return sshHost;
  return `${sshHost}.${DEFAULT_MAGIC_DNS_SUFFIX}`;
}

async function readRoutes(host: string, runner: SshRunner): Promise<TailscaleRoute[]> {
  await runSsh(host, runner, "tailscale serve status", "capture Tailscale Serve status", true);
  const json = await runSsh(host, runner, "tailscale serve status --json", "capture Tailscale Serve JSON status");
  return parseRoutes(json.stdout);
}

async function checkReachabilityVps(host: string, runner: SshRunner, url: string): Promise<boolean> {
  const result = await runSsh(host, runner, `curl -sS ${url}`, "check VPS Tailscale route reachability", true);
  return result.exitCode === 0 && result.stdout.trim() === "ok";
}

async function checkReachabilityLocal(runner: CommandRunner, url: string): Promise<boolean> {
  const result = await runner.run("curl", ["-sS", url]);
  return result.exitCode === 0 && result.stdout.trim() === "ok";
}

export async function runInstallTailscaleRoute(
  opts: InstallTailscaleRouteOptions = {},
): Promise<InstallTailscaleRouteResult> {
  const host = opts.sshHost ?? (await readConfiguredHost()) ?? DEFAULT_HOST;
  const dashboardPort = opts.dashboardPort ?? DEFAULT_DASHBOARD_PORT;
  const pathPrefix = normalizePathPrefix(opts.pathPrefix ?? DEFAULT_PATH_PREFIX);
  const sshRunner = opts.sshRunner ?? makeRealSshRunner();
  const commandRunner = opts.commandRunner ?? makeRealCommandRunner();
  const serveCommand = buildServeCommand(pathPrefix, dashboardPort);
  const expectedMemoryTarget = `http://127.0.0.1:${dashboardPort}`;

  const preRoutes = await readRoutes(host, sshRunner);
  assertExpectedBaseRoutes(preRoutes);

  const existingMemory = findPathRoute(preRoutes, pathPrefix);
  if (existingMemory && existingMemory.target !== expectedMemoryTarget) {
    throw new Error(`${pathPrefix} already exists but points to ${existingMemory.target}; refusing to modify Tailscale Serve`);
  }

  if (opts.dryRun === true) {
    process.stdout.write(`[dry-run] $ ssh ${host} '${serveCommand}'\n`);
    return {
      host,
      pathPrefix,
      dashboardPort,
      preExistingRoutes: preRoutes,
      postRoutes: preRoutes,
      alreadyConfigured: existingMemory !== null,
      serveCommand,
      reachabilityVps: false,
      reachabilityLocal: false,
    };
  }

  let postRoutes = preRoutes;
  let alreadyConfigured = false;
  if (existingMemory) {
    alreadyConfigured = true;
  } else {
    await runSsh(host, sshRunner, serveCommand, "add memory Tailscale Serve path route");
    postRoutes = await readRoutes(host, sshRunner);
    try {
      assertExpectedBaseRoutes(postRoutes);
      if (!hasRoute(postRoutes, ":443", pathPrefix, expectedMemoryTarget)) {
        throw new Error(`${pathPrefix} -> ${expectedMemoryTarget} was not present after install`);
      }
    } catch (err) {
      throw new Error(`${(err as Error).message}. Tailscale Serve post-check failed; manually inspect routes before retrying.`);
    }
  }

  const dnsHost = magicDnsHost(host, postRoutes);
  const healthUrl = `https://${dnsHost}${pathPrefix}/healthz`;
  const reachabilityVps = await checkReachabilityVps(host, sshRunner, healthUrl);
  const reachabilityLocal = await checkReachabilityLocal(commandRunner, healthUrl);
  if (!reachabilityVps || !reachabilityLocal) {
    throw new Error(`Tailscale route reachability failed for ${healthUrl}: VPS=${reachabilityVps}, local=${reachabilityLocal}`);
  }

  return {
    host,
    pathPrefix,
    dashboardPort,
    preExistingRoutes: preRoutes,
    postRoutes,
    alreadyConfigured,
    serveCommand,
    reachabilityVps,
    reachabilityLocal,
  };
}
