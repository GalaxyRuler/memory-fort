import { existsSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const OPENCOVEN_API_VERSION = "coven.daemon.v1";
const OPENCOVEN_INSTALL_HINT =
  "install with `npm install -g @opencoven/cli` or run `npx @opencoven/cli doctor`";

export type OpenCovenReadinessState = "installed" | "stale" | "missing";

export interface OpenCovenHealthResponse {
  ok?: unknown;
  apiVersion?: unknown;
  covenVersion?: unknown;
  capabilities?: {
    sessions?: unknown;
    events?: unknown;
    eventCursor?: unknown;
    structuredErrors?: unknown;
  };
  daemon?: { socket?: unknown } | null;
}

export interface OpenCovenReadiness {
  state: OpenCovenReadinessState;
  detail: string;
  socketPath: string;
  commandPath?: string;
}

export interface OpenCovenReadinessOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homeDir?: string;
  fs?: { existsSync(path: string): boolean };
  findCommand?: (
    command: string,
    opts: Required<Pick<OpenCovenReadinessOptions, "env" | "platform" | "fs">>,
  ) => string | null;
  healthProbe?: (socketPath: string) => Promise<OpenCovenHealthResponse>;
}

export interface InstallOpenCovenResult extends OpenCovenReadiness {
  plannedWrites: string[];
  log: string[];
}

export async function runInstallOpenCoven(
  opts: OpenCovenReadinessOptions = {},
): Promise<InstallOpenCovenResult> {
  const status = await readOpenCovenReadiness(opts);
  return {
    ...status,
    plannedWrites: [],
    log: ["read-only readiness check; no files written", status.detail],
  };
}

export async function readOpenCovenReadiness(
  opts: OpenCovenReadinessOptions = {},
): Promise<OpenCovenReadiness> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const fs = opts.fs ?? { existsSync };
  const command = env["MEMORY_OPENCOVEN_COMMAND"]?.trim() || "coven";
  const socketPath = openCovenSocketPath({ env, homeDir: opts.homeDir });
  const commandPath = (opts.findCommand ?? findCommandOnPath)(command, {
    env,
    platform,
    fs,
  });

  if (!commandPath) {
    return {
      state: "missing",
      socketPath,
      detail: `coven CLI not found; ${OPENCOVEN_INSTALL_HINT}`,
    };
  }

  const healthProbe = opts.healthProbe ?? defaultOpenCovenHealthProbe;
  let health: OpenCovenHealthResponse;
  try {
    health = await healthProbe(socketPath);
  } catch (err) {
    return {
      state: "stale",
      commandPath,
      socketPath,
      detail: `coven CLI available at ${commandPath}; daemon not reachable at ${socketPath}; run \`coven daemon start\` (${(err as Error).message})`,
    };
  }

  return evaluateOpenCovenHealth({ health, commandPath, socketPath });
}

export function findCommandOnPath(
  command: string,
  opts: Required<Pick<OpenCovenReadinessOptions, "env" | "platform" | "fs">>,
): string | null {
  if (hasPathSeparator(command) || isAbsolute(command)) {
    return opts.fs.existsSync(command) ? command : null;
  }

  const pathValue = opts.env["PATH"] ?? "";
  const pathExts = opts.platform === "win32"
    ? (opts.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((ext) => ext.trim())
        .filter(Boolean)
    : [""];
  const hasExtension = /\.[^\\/]+$/.test(command);

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidates = opts.platform === "win32" && !hasExtension
      ? ["", ...pathExts].map((ext) => join(dir, `${command}${ext}`))
      : [join(dir, command)];
    for (const candidate of candidates) {
      if (opts.fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function openCovenSocketPath(opts: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
} = {}): string {
  const env = opts.env ?? process.env;
  const covenHome = env["COVEN_HOME"]?.trim() || join(opts.homeDir ?? homedir(), ".coven");
  return join(covenHome, "coven.sock");
}

async function defaultOpenCovenHealthProbe(
  socketPath: string,
): Promise<OpenCovenHealthResponse> {
  return new Promise((resolvePromise, reject) => {
    const req = request({
      method: "GET",
      path: "/api/v1/health",
      socketPath,
      timeout: 1500,
    }, (res) => {
      const chunks: string[] = [];
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => chunks.push(chunk));
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode ?? "unknown"}`));
          return;
        }
        try {
          resolvePromise(JSON.parse(chunks.join("")) as OpenCovenHealthResponse);
        } catch (err) {
          reject(new Error(`invalid JSON: ${(err as Error).message}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function evaluateOpenCovenHealth(args: {
  health: OpenCovenHealthResponse;
  commandPath: string;
  socketPath: string;
}): OpenCovenReadiness {
  const { health, commandPath, socketPath } = args;
  const apiVersion = typeof health.apiVersion === "string" ? health.apiVersion : "";
  if (apiVersion !== OPENCOVEN_API_VERSION) {
    return {
      state: "stale",
      commandPath,
      socketPath,
      detail: `unsupported Coven API ${apiVersion || "(missing)"}; expected ${OPENCOVEN_API_VERSION}; update Coven or Memory Fort`,
    };
  }

  const capabilities = health.capabilities;
  const missing = [
    capabilities?.sessions === true ? null : "sessions",
    capabilities?.events === true ? null : "events",
    capabilities?.structuredErrors === true ? null : "structuredErrors",
    capabilities?.eventCursor === "sequence" ? null : "eventCursor=sequence",
  ].filter((item): item is string => item !== null);
  if (missing.length > 0) {
    return {
      state: "stale",
      commandPath,
      socketPath,
      detail: `coven daemon reachable but missing required capabilities: ${missing.join(", ")}`,
    };
  }

  const version = typeof health.covenVersion === "string" && health.covenVersion
    ? ` ${health.covenVersion}`
    : "";
  return {
    state: "installed",
    commandPath,
    socketPath,
    detail: `coven CLI available at ${commandPath}; daemon ${apiVersion}${version}; sessions/events ready`,
  };
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}
