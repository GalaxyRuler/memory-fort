import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import {
  type CapabilityDb,
  assertFts5,
  assertVec0Knn,
  closeCapabilityDb,
  loadSqliteVec,
  openCapabilityDb,
  resolveSqliteVecBinary,
} from "./capability.js";
import type { DashboardServiceRuntimeEnv } from "../../dashboard/dashboard-service-supervisor.js";

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
}

interface ProbeInit {
  readonly vaultRoot: string;
  readonly dashboardDistRoot: string;
  readonly runtimeEnv?: DashboardServiceRuntimeEnv;
}

interface ProbeBinary {
  readonly label: string;
  readonly path: string;
  readonly arch: string;
}

interface SqliteVersionRow {
  readonly version: string;
}

interface CompileOptionRow {
  readonly compile_options: string;
}

const require = createRequire(import.meta.url);
const parentPort = process.parentPort;

if (!parentPort) {
  console.error("[cap-probe] process.parentPort is required");
  process.exit(1);
}

if (process.env["MEMORY_CAP_PROBE"] !== "1") {
  console.error("[cap-probe] MEMORY_CAP_PROBE=1 is required");
  process.exit(1);
}

waitForInit(parentPort)
  .then((init) => runCapabilityProbe(parentPort, init))
  .catch((error: unknown) => {
    console.error(`[cap-probe] fatal ${formatErrorForLog(error)}`);
    process.exit(1);
  });

async function runCapabilityProbe(port: ParentPort, init: ProbeInit): Promise<void> {
  const probeDir = await createProbeDir();
  const logPath = join(probeDir, "cap-probe.log");
  const logger = async (line: string) => {
    const entry = `[${new Date().toISOString()}] ${line}`;
    await appendFile(logPath, `${entry}\n`, "utf8");
    console.info(`[cap-probe] ${line}`);
    port.postMessage({ type: "cap-probe-log", line, logPath });
  };

  let db: CapabilityDb | null = null;
  let betterSqliteBinary: ProbeBinary | null = null;
  let sqliteVecBinary: ProbeBinary | null = null;
  let exitCode = 0;

  try {
    await logger(`log path ${logPath}`);
    await runStep(1, "runtime-paths", logger, async () => {
      await logger(`execPath=${process.execPath}`);
      await logger(`cwd=${process.cwd()}`);
      await logger(`resourcesPath=${getResourcesPath() ?? "n/a"}`);
      await logger(`parentAppPath=${init.runtimeEnv?.appPath ?? process.env["MEMORY_FORT_APP_PATH"] ?? "n/a"}`);
      await logger(`platform=${process.platform} arch=${process.arch}`);
      await logger(
        `versions=${JSON.stringify({
          electron: process.versions.electron ?? null,
          node: process.versions.node,
          modules: process.versions.modules,
        })}`,
      );
    });

    await runStep(2, "wal-open-native-stats", logger, async () => {
      if (!hasSpaceAndUnicode(probeDir)) {
        throw new Error(`probe directory must contain a space and Unicode character: ${probeDir}`);
      }
      const dbPath = join(probeDir, "capability.sqlite");
      db = openCapabilityDb(dbPath);
      await logger(`db path ${db.path}`);
      betterSqliteBinary = await describeBinary("better_sqlite3.node", resolveBetterSqliteNativeBinary(), logger);
      sqliteVecBinary = await describeBinary("sqlite-vec", resolveSqliteVecBinary(), logger);
      const version = db.database.prepare<[], SqliteVersionRow>("select sqlite_version() as version").get()?.version;
      const compileOptions = db.database
        .prepare<[], CompileOptionRow>("pragma compile_options")
        .all()
        .map((row) => row.compile_options);
      await logger(`sqlite_version=${version ?? "unknown"}`);
      await logger(`compile_options=${JSON.stringify(compileOptions)}`);
    });

    await runStep(3, "fts5", logger, async () => {
      assertDb(db);
      assertFts5(db);
      await logger("fts5 ok");
    });

    await runStep(4, "vec-load", logger, async () => {
      assertDb(db);
      loadSqliteVec(db);
      await logger("vec-load ok");
    });

    await runStep(5, "vec-knn", logger, async () => {
      assertDb(db);
      assertVec0Knn(db);
      await logger("vec-knn ok");
    });

    await runStep(6, "runtime-path-guard", logger, async () => {
      if (!betterSqliteBinary || !sqliteVecBinary) throw new Error("native binary metadata was not collected");
      assertRuntimePathGuard([betterSqliteBinary, sqliteVecBinary], init);
      await logger("runtime-path guard ok");
    });

    await logger("steps 1-6 ok");
    const shutdown = waitForShutdown(port, 30_000);
    port.postMessage({ type: "cap-probe-ready", url: "cap-probe://ok", port: 0, logPath });
    await shutdown;
  } catch (error) {
    exitCode = 1;
    const message = formatErrorForLog(error);
    await logger(`FAIL ${message}`);
    port.postMessage({ type: "cap-probe-fail", error: message, logPath });
  } finally {
    if (db) {
      try {
        closeCapabilityDb(db);
      } catch (error) {
        await logger(`close warning ${formatErrorForLog(error)}`);
      }
    }
  }
  process.exit(exitCode);
}

async function runStep(
  step: number,
  name: string,
  logger: (line: string) => Promise<void>,
  fn: () => Promise<void>,
): Promise<void> {
  await logger(`step${step} ${name} start`);
  try {
    await fn();
    await logger(`step${step} ${name} ok`);
  } catch (error) {
    await logger(`step${step} ${name} FAIL ${formatErrorForLog(error)}`);
    throw error;
  }
}

function waitForInit(port: ParentPort): Promise<ProbeInit> {
  return new Promise((resolveInit, reject) => {
    port.on("message", (message) => {
      const payload = unwrapParentPortMessage(message);
      if (!isProbeInit(payload)) {
        reject(new Error("capability probe expected dashboard supervisor init payload"));
        return;
      }
      resolveInit(payload);
    });
  });
}

function waitForShutdown(port: ParentPort, timeoutMs: number): Promise<void> {
  return new Promise((resolveShutdown) => {
    const timer = setTimeout(resolveShutdown, timeoutMs);
    port.on("message", (message) => {
      const payload = unwrapParentPortMessage(message);
      if (payload === "shutdown" || (
        typeof payload === "object" &&
        payload !== null &&
        (payload as { type?: unknown }).type === "shutdown"
      )) {
        clearTimeout(timer);
        resolveShutdown();
      }
    });
  });
}

function isProbeInit(message: unknown): message is ProbeInit {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { vaultRoot?: unknown }).vaultRoot === "string" &&
    typeof (message as { dashboardDistRoot?: unknown }).dashboardDistRoot === "string"
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

async function createProbeDir(): Promise<string> {
  const base = resolve(process.env["MEMORY_CAP_PROBE_LOG_DIR"] ?? tmpdir());
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "Memory Fort cap probe Ω-"));
}

function hasSpaceAndUnicode(value: string): boolean {
  return /\s/.test(value) && /[^\x00-\x7F]/.test(value);
}

function assertDb(db: CapabilityDb | null): asserts db is CapabilityDb {
  if (!db) throw new Error("capability database was not opened");
}

function resolveBetterSqliteNativeBinary(): string {
  try {
    return require.resolve("better-sqlite3/build/Release/better_sqlite3.node");
  } catch {
    const entry = require.resolve("better-sqlite3");
    return join(dirname(entry), "..", "build", "Release", "better_sqlite3.node");
  }
}

async function describeBinary(
  label: string,
  binaryPath: string,
  logger: (line: string) => Promise<void>,
): Promise<ProbeBinary> {
  if (!isAbsolute(binaryPath)) throw new Error(`${label} path is not absolute: ${binaryPath}`);
  if (!existsSync(binaryPath)) throw new Error(`${label} does not exist: ${binaryPath}`);
  const fileStat = await stat(binaryPath);
  const sha256 = sha256File(binaryPath);
  const arch = detectNativeBinaryArch(binaryPath);
  await logger(
    `${label} path=${binaryPath} size=${fileStat.size} mtime=${fileStat.mtime.toISOString()} sha256=${sha256} arch=${arch}`,
  );
  return { label, path: binaryPath, arch };
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertRuntimePathGuard(binaries: readonly ProbeBinary[], init: ProbeInit): void {
  const appPath = init.runtimeEnv?.appPath ?? process.env["MEMORY_FORT_APP_PATH"];
  const resourcesPath = getResourcesPath();
  if (!appPath || !isAbsolute(appPath)) throw new Error(`appPath is not absolute: ${String(appPath)}`);
  if (!resourcesPath || !isAbsolute(resourcesPath)) {
    throw new Error(`process.resourcesPath is not absolute: ${String(resourcesPath)}`);
  }
  if ((process as NodeJS.Process & { readonly defaultApp?: boolean }).defaultApp) {
    throw new Error("probe is running under Electron defaultApp/dev mode, not an installed app");
  }
  if (isUnpackedBuildTree(appPath)) {
    throw new Error(`probe appPath is an unpacked build tree, not an installed app: ${appPath}`);
  }
  for (const binary of binaries) {
    if (!isInside(appPath, binary.path) && !isInside(resourcesPath, binary.path)) {
      throw new Error(`${binary.label} resolved outside installed app: ${binary.path}`);
    }
    if (binary.arch !== "unknown" && binary.arch !== process.arch) {
      throw new Error(`${binary.label} arch ${binary.arch} does not match process.arch ${process.arch}`);
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isUnpackedBuildTree(appPath: string): boolean {
  const normalized = appPath.toLowerCase();
  const distInstaller = `${sep}dist${sep}electron-installer${sep}`.toLowerCase();
  return (
    normalized.includes(distInstaller) ||
    normalized.includes(`${sep}win-unpacked${sep}`.toLowerCase()) ||
    normalized.includes(`${sep}linux-unpacked${sep}`.toLowerCase())
  );
}

function detectNativeBinaryArch(filePath: string): string {
  if (process.platform === "win32") return readPeArch(filePath);
  const result = spawnSync("file", ["-b", filePath], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""} ${result.stderr ?? ""}`;
  if (/arm64|aarch64/i.test(output)) return "arm64";
  if (/x86[-_ ]64|amd64/i.test(output)) return "x64";
  return "unknown";
}

function readPeArch(filePath: string): string {
  const bytes = readFileSync(filePath);
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") return "unknown";
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\u0000\u0000") {
    return "unknown";
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  if (machine === 0xaa64) return "arm64";
  if (machine === 0x8664) return "x64";
  if (machine === 0x014c) return "ia32";
  return "unknown";
}

function getResourcesPath(): string | null {
  return (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath ?? null;
}

function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    const step = (error as { readonly step?: unknown }).step;
    const prefix = typeof step === "string" ? `${error.name} step=${step}` : error.name;
    return error.stack ? `${prefix}: ${error.message}\n${error.stack}` : `${prefix}: ${error.message}`;
  }
  return String(error);
}

declare global {
  namespace NodeJS {
    interface Process {
      parentPort?: ParentPort;
    }
  }
}
