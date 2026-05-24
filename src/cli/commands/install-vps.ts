import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath } from "../../storage/paths.js";
import { type SshCommand, type SshRunner } from "../../sync/ssh-runner.js";

export interface InstallVpsOptions {
  sshHost?: string;
  installRoot?: string;
  dryRun?: boolean;
  runner?: SshRunner;
  localRunner?: LocalCommandRunner;
  dashboardDistRoot?: string;
}

export interface InstallVpsResult {
  host: string;
  installRoot: string;
  steps: Array<{ command: string; description: string; output: string; exitCode: number }>;
  preSnapshot: { tailscaleServe: string; listening: string; caddyStatus: string };
  postSnapshot: { tailscaleServe: string; listening: string; caddyStatus: string };
  servicesChanged: boolean;
  systemd: {
    dashboardServiceActive: boolean;
    backupTimerActive: boolean;
    backupTimerNext: string;
    healthzOk: boolean;
    nodePath: string;
  };
}

interface Snapshot {
  tailscaleServe: string;
  listening: string;
  caddyStatus: string;
}

export interface LocalCommandRunner {
  run(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const DEFAULT_HOST = "srv1317946";
const DEFAULT_INSTALL_ROOT = "/root/memory-system";
const DEFAULT_NODE_PATH = "/usr/local/node22/bin/node";
const UPLOAD_CHUNK_SIZE = 12_000;

const SNAPSHOT_COMMANDS: Array<SshCommand & { key: keyof Snapshot }> = [
  {
    key: "tailscaleServe",
    command: "tailscale serve status",
    description: "capture Tailscale Serve status",
    allowNonZeroExit: true,
  },
  {
    key: "listening",
    command: "ss -tlnp | head -50",
    description: "capture listening TCP ports",
    allowNonZeroExit: true,
  },
  {
    key: "caddyStatus",
    command: "systemctl is-active caddy vaultwarden 2>&1 || true",
    description: "capture Caddy and Vaultwarden service status",
    allowNonZeroExit: true,
  },
];

function emptySnapshot(): Snapshot {
  return { tailscaleServe: "", listening: "", caddyStatus: "" };
}

function emptySystemd(nodePath = ""): InstallVpsResult["systemd"] {
  return {
    dashboardServiceActive: false,
    backupTimerActive: false,
    backupTimerNext: "",
    healthzOk: false,
    nodePath,
  };
}

function isSafeRemotePath(path: string): boolean {
  return path.startsWith("/") && !path.includes("'") && !path.includes("\n") && !path.includes("\r");
}

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
    if (inVpsBlock) {
      const host = /^[ \t]+host:\s*["']?([^"'\r\n#]+)["']?/.exec(line)?.[1]?.trim();
      if (host && host.length > 0) return host;
    }
  }
  return null;
}

function buildInstallInfoContent(installRoot: string, now: Date): string {
  return JSON.stringify(
    {
      installed_at: now.toISOString(),
      installed_by: "memory install-vps",
      version: "0.3.0-phase3-dev",
      install_root: installRoot,
    },
    null,
    2,
  );
}

function buildInstallInfoCommand(installRoot: string, now: Date): SshCommand {
  const info = buildInstallInfoContent(installRoot, now);
  return {
    command: `cat > ${installRoot}/install-info.json <<EOF\n${info}\nEOF`,
    description: "write install-info.json",
  };
}

function buildLayoutCommands(
  installRoot: string,
  includeMkdir: boolean,
  now: Date,
  useChunkedWrites = false,
): SshCommand[] {
  const commands: SshCommand[] = [];
  if (includeMkdir) {
    commands.push({
      command: `mkdir -p ${installRoot}/{vault,backups,logs,services,env}`,
      description: "create directory tree",
    });
  }
  commands.push(
    {
      command: `[ -d ${installRoot}/memory.git ] || git init --bare ${installRoot}/memory.git`,
      description: "initialize bare git repo (idempotent)",
    },
    {
      command: `chmod 700 ${installRoot}`,
      description: "lock down install root to root-only",
    },
    {
      command: `chmod 700 ${installRoot}/env`,
      description: "lock down env directory to root-only",
    },
  );
  commands.push(
    ...(useChunkedWrites
      ? uploadChunkedCommands(
        `${installRoot}/install-info.json`,
        buildInstallInfoContent(installRoot, now),
        "write install-info.json",
      )
      : [buildInstallInfoCommand(installRoot, now)]),
  );
  return commands;
}

function buildIdempotencyCommand(installRoot: string): SshCommand {
  return {
    command: `test -d ${installRoot} && echo EXISTS || echo MISSING`,
    description: "check existing install root",
  };
}

function snapshotChanged(a: Snapshot, b: Snapshot): boolean {
  return normalizeSnapshotText(a.tailscaleServe) !== normalizeSnapshotText(b.tailscaleServe) ||
    normalizeListeningPorts(a.listening) !== normalizeListeningPorts(b.listening) ||
    normalizeSnapshotText(a.caddyStatus) !== normalizeSnapshotText(b.caddyStatus);
}

function normalizeListeningPorts(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !line.includes(":4410"))
    .map((line) => line.trim().split(/\s+/)[3] ?? "")
    .filter((port) => port.length > 0 && port !== "Local")
    .sort()
    .join("\n");
}

function normalizeSnapshotText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort()
    .join("\n");
}

async function runChecked(host: string, runner: SshRunner, cmd: SshCommand) {
  const result = await runner.run(host, cmd);
  if (result.exitCode !== 0 && cmd.allowNonZeroExit !== true) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`SSH command failed (${cmd.description}): ${cmd.command}: ${detail}`);
  }
  return result;
}

function makeInstallVpsSshRunner(): SshRunner {
  return {
    run(host: string, cmd: SshCommand) {
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn("ssh", [host, cmd.command], {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (err) {
          reject(new Error(
            `ssh failed to start (${cmd.description}; command length ${cmd.command.length}): ${(err as Error).message}`,
          ));
          return;
        }
        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on("error", (err) => {
          reject(new Error(`ssh failed to start: ${err.message}`));
        });
        child.on("close", (code) => {
          resolve({ stdout, stderr, exitCode: code ?? -1 });
        });
      });
    },
  };
}

function makeLocalCommandRunner(): LocalCommandRunner {
  return {
    run(command: string, args: string[]) {
      return new Promise((resolve, reject) => {
        const spawnCommand = process.platform === "win32" && command.endsWith(".cmd") ? "cmd.exe" : command;
        const spawnArgs = spawnCommand === "cmd.exe" ? ["/d", "/s", "/c", command, ...args] : args;
        let child;
        try {
          child = spawn(spawnCommand, spawnArgs, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (err) {
          reject(new Error(
            `${command} failed to start (args length ${args.join(" ").length}): ${(err as Error).message}`,
          ));
          return;
        }
        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on("error", (err) => {
          reject(new Error(`${command} failed to start: ${err.message}`));
        });
        child.on("close", (code) => {
          resolve({ stdout, stderr, exitCode: code ?? -1 });
        });
      });
    },
  };
}

async function captureSnapshot(host: string, runner: SshRunner): Promise<Snapshot> {
  const snapshot = emptySnapshot();
  for (const cmd of SNAPSHOT_COMMANDS) {
    const result = await runChecked(host, runner, cmd);
    snapshot[cmd.key] = result.stdout;
  }
  return snapshot;
}

function printDryRun(host: string, commands: SshCommand[]): void {
  for (const cmd of commands) {
    process.stdout.write(`[dry-run] $ ssh ${host} '${cmd.command}'\n`);
  }
}

function printDryRunLocal(command: string, args: string[]): void {
  process.stdout.write(`[dry-run] $ ${formatLocalCommand(command, args)}\n`);
}

function resolveDashboardDistRoot(input: string | undefined): string {
  return input ? resolve(input) : resolve(process.cwd(), "dist", "dashboard-ui");
}

function assertDashboardDistReady(root: string): void {
  if (!existsSync(join(root, "index.html"))) {
    throw new Error(`dashboard UI dist missing at ${root}; run npm run build:ui before memory install-vps`);
  }
}

function rsyncPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function scpContentsPath(path: string): string {
  return `${rsyncPath(path)}.`;
}

function formatLocalCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function buildDashboardUi(localRunner: LocalCommandRunner): Promise<InstallVpsResult["steps"][number]> {
  const command = npmCommand();
  const args = ["run", "build:ui"];
  const result = await localRunner.run(command, args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`local command failed (build dashboard UI): ${formatLocalCommand(command, args)}: ${detail}`);
  }
  return {
    command: formatLocalCommand(command, args),
    description: "build dashboard UI static assets",
    output: result.stdout || result.stderr,
    exitCode: result.exitCode,
  };
}

async function syncDashboardUiDist(
  host: string,
  installRoot: string,
  runner: SshRunner,
  localRunner: LocalCommandRunner,
  dashboardDistRoot: string,
): Promise<InstallVpsResult["steps"]> {
  const steps: InstallVpsResult["steps"] = [];
  steps.push(await buildDashboardUi(localRunner));
  assertDashboardDistReady(dashboardDistRoot);

  const mkdirCommand: SshCommand = {
    command: `mkdir -p ${installRoot}/dist/dashboard-ui`,
    description: "create dashboard UI dist directory",
  };
  const mkdirResult = await runChecked(host, runner, mkdirCommand);
  steps.push({
    command: mkdirCommand.command,
    description: mkdirCommand.description,
    output: mkdirResult.stdout || mkdirResult.stderr,
    exitCode: mkdirResult.exitCode,
  });

  const args = [
    "-az",
    "--delete",
    rsyncPath(dashboardDistRoot),
    `${host}:${installRoot}/dist/dashboard-ui/`,
  ];
  let result;
  try {
    result = await localRunner.run("rsync", args);
  } catch (err) {
    const message = (err as Error).message;
    if (!message.includes("ENOENT") && !message.includes("rsync failed to start")) {
      throw err;
    }
    steps.push(...await syncDashboardUiDistWithScpFallback(
      host,
      installRoot,
      runner,
      localRunner,
      dashboardDistRoot,
      message,
    ));
    return steps;
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`local command failed (upload dashboard UI static assets): ${formatLocalCommand("rsync", args)}: ${detail}`);
  }
  steps.push({
    command: formatLocalCommand("rsync", args),
    description: "upload dashboard UI static assets",
    output: result.stdout || result.stderr,
    exitCode: result.exitCode,
  });

  return steps;
}

async function syncDashboardUiDistWithScpFallback(
  host: string,
  installRoot: string,
  runner: SshRunner,
  localRunner: LocalCommandRunner,
  dashboardDistRoot: string,
  rsyncFailure: string,
): Promise<InstallVpsResult["steps"]> {
  const steps: InstallVpsResult["steps"] = [];
  const resetCommand: SshCommand = {
    command: `rm -rf ${installRoot}/dist/dashboard-ui && mkdir -p ${installRoot}/dist/dashboard-ui`,
    description: "reset dashboard UI dist directory for scp fallback",
  };
  const resetResult = await runChecked(host, runner, resetCommand);
  steps.push({
    command: resetCommand.command,
    description: resetCommand.description,
    output: resetResult.stdout || resetResult.stderr,
    exitCode: resetResult.exitCode,
  });

  const args = [
    "-r",
    scpContentsPath(dashboardDistRoot),
    `${host}:${installRoot}/dist/dashboard-ui/`,
  ];
  const result = await localRunner.run("scp", args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`local command failed (upload dashboard UI static assets via scp fallback after ${rsyncFailure}): ${formatLocalCommand("scp", args)}: ${detail}`);
  }
  steps.push({
    command: formatLocalCommand("scp", args),
    description: "upload dashboard UI static assets via scp fallback",
    output: result.stdout || result.stderr,
    exitCode: result.exitCode,
  });
  return steps;
}

async function readTemplate(...parts: string[]): Promise<string> {
  const local = resolve(process.cwd(), "templates", ...parts);
  if (existsSync(local)) return readFile(local, "utf-8");
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates", ...parts);
  return readFile(bundled, "utf-8");
}

async function readDashboardBundle(): Promise<string> {
  const candidates = [
    resolve(process.cwd(), "dist", "dashboard", "server.mjs"),
    resolve(dirname(fileURLToPath(import.meta.url)), "dashboard", "server.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFile(candidate, "utf-8");
  }
  if (process.env["VITEST"]) {
    return "export async function createServer() { throw new Error('dashboard bundle unavailable in unit tests'); }\n";
  }
  throw new Error("dashboard bundle missing at dist/dashboard/server.mjs; run npm run build before memory install-vps");
}

function uploadCommand(path: string, content: string, description: string): SshCommand {
  return {
    command: `cat > ${path} <<'EOF'\n${content.replace(/\r\n/g, "\n")}\nEOF`,
    description,
  };
}

function uploadChunkedCommands(path: string, content: string, description: string): SshCommand[] {
  const encoded = Buffer.from(content.replace(/\r\n/g, "\n"), "utf-8").toString("base64");
  const tempPath = `${path}.b64`;
  const commands: SshCommand[] = [
    {
      command: `: > ${tempPath}`,
      description: `${description} (prepare chunks)`,
    },
  ];

  const chunkCount = Math.ceil(encoded.length / UPLOAD_CHUNK_SIZE);
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = encoded.slice(index * UPLOAD_CHUNK_SIZE, (index + 1) * UPLOAD_CHUNK_SIZE);
    commands.push({
      command: `printf '%s' '${chunk}' >> ${tempPath}`,
      description: `${description} (chunk ${index + 1}/${chunkCount})`,
    });
  }

  commands.push({
    command: `base64 -d ${tempPath} > ${path} && rm -f ${tempPath}`,
    description,
  });
  return commands;
}

async function buildSystemdCommands(
  installRoot: string,
  nodePath: string,
  useChunkedWrites = false,
): Promise<SshCommand[]> {
  const dashboardUnit = (await readTemplate("systemd", "memory-dashboard.service"))
    .replaceAll("${INSTALL_ROOT}", installRoot)
    .replaceAll("${NODE_PATH}", nodePath);
  const backupService = (await readTemplate("systemd", "memory-backup.service")).replaceAll("${INSTALL_ROOT}", installRoot);
  const backupTimer = await readTemplate("systemd", "memory-backup.timer");
  const backupScript = (await readTemplate("scripts", "memory-backup.sh")).replaceAll("/root/memory-system", installRoot);
  const dashboardScript = (await readTemplate("scripts", "dashboard.mjs")).replaceAll("/root/memory-system", installRoot);
  const dashboardBundle = await readDashboardBundle();
  const placeholder = await readTemplate("scripts", "dashboard-placeholder.mjs");
  const uploadFileCommands = (path: string, content: string, description: string): SshCommand[] =>
    useChunkedWrites ? uploadChunkedCommands(path, content, description) : [uploadCommand(path, content, description)];

  return [
    ...uploadFileCommands(`${installRoot}/services/memory-backup.sh`, backupScript, "upload backup runner"),
    { command: `chmod 755 ${installRoot}/services/memory-backup.sh`, description: "make backup runner executable" },
    ...uploadFileCommands(`${installRoot}/services/dashboard.mjs`, dashboardScript, "upload dashboard entry point"),
    { command: `chmod 644 ${installRoot}/services/dashboard.mjs`, description: "set dashboard entry point permissions" },
    ...uploadChunkedCommands(`${installRoot}/services/dashboard-bundle.mjs`, dashboardBundle, "upload dashboard bundle"),
    { command: `chmod 644 ${installRoot}/services/dashboard-bundle.mjs`, description: "set dashboard bundle permissions" },
    {
      command: `cd ${installRoot}/services && if [ ! -f package.json ]; then npm init -y >/dev/null; fi && npm install voyageai@~0.2.1 gray-matter@^4 js-yaml@^4 >/dev/null`,
      description: "install dashboard runtime dependencies",
    },
    ...uploadFileCommands(`${installRoot}/services/dashboard-placeholder.mjs`, placeholder, "upload dashboard placeholder"),
    { command: `chmod 644 ${installRoot}/services/dashboard-placeholder.mjs`, description: "set dashboard placeholder permissions" },
    ...uploadFileCommands("/etc/systemd/system/memory-dashboard.service", dashboardUnit, "upload memory-dashboard.service"),
    { command: "chmod 644 /etc/systemd/system/memory-dashboard.service", description: "set dashboard service permissions" },
    ...uploadFileCommands("/etc/systemd/system/memory-backup.service", backupService, "upload memory-backup.service"),
    { command: "chmod 644 /etc/systemd/system/memory-backup.service", description: "set backup service permissions" },
    ...uploadFileCommands("/etc/systemd/system/memory-backup.timer", backupTimer, "upload memory-backup.timer"),
    { command: "chmod 644 /etc/systemd/system/memory-backup.timer", description: "set backup timer permissions" },
    { command: "systemctl daemon-reload", description: "reload systemd units" },
    { command: "systemctl enable --now memory-dashboard.service", description: "enable and start memory dashboard" },
    { command: "systemctl restart memory-dashboard.service", description: "restart memory dashboard with latest files" },
    { command: "systemctl enable --now memory-backup.timer", description: "enable and start backup timer" },
  ];
}

async function resolveNodePath(host: string, runner: SshRunner): Promise<string> {
  const result = await runChecked(host, runner, {
    command: "which node",
    description: "resolve Node path",
    allowNonZeroExit: true,
  });
  const nodePath = result.stdout.trim();
  if (result.exitCode !== 0 || !nodePath) {
    throw new Error(`Node not found on ${host}; install Node or ensure ${DEFAULT_NODE_PATH} is available`);
  }
  return nodePath;
}

function parseTimerNext(output: string): string {
  const match = /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+UTC/.exec(output);
  if (!match) return "";
  return `${match[1]}T${match[2]}Z`;
}

async function verifySystemd(host: string, runner: SshRunner, nodePath: string): Promise<InstallVpsResult["systemd"]> {
  const dashboard = await runChecked(host, runner, {
    command: "systemctl is-active memory-dashboard.service",
    description: "verify memory dashboard service",
    allowNonZeroExit: true,
  });
  const timer = await runChecked(host, runner, {
    command: "systemctl is-active memory-backup.timer",
    description: "verify memory backup timer",
    allowNonZeroExit: true,
  });
  const timerList = await runChecked(host, runner, {
    command: "systemctl list-timers memory-backup.timer --no-pager",
    description: "capture memory backup timer schedule",
    allowNonZeroExit: true,
  });
  const healthz = await runChecked(host, runner, {
    command: "curl -sS http://127.0.0.1:4410/healthz",
    description: "verify dashboard health endpoint",
    allowNonZeroExit: true,
  });
  await runChecked(host, runner, {
    command: 'ss -tlnp | grep ":4410"',
    description: "verify dashboard port listener",
    allowNonZeroExit: true,
  });

  return {
    dashboardServiceActive: dashboard.stdout.trim() === "active",
    backupTimerActive: timer.stdout.trim() === "active",
    backupTimerNext: parseTimerNext(timerList.stdout),
    healthzOk: healthz.stdout.trim() === "ok",
    nodePath,
  };
}

export async function runInstallVps(opts: InstallVpsOptions = {}): Promise<InstallVpsResult> {
  const host = opts.sshHost ?? (await readConfiguredHost()) ?? DEFAULT_HOST;
  const installRoot = opts.installRoot ?? DEFAULT_INSTALL_ROOT;
  if (!isSafeRemotePath(installRoot)) {
    throw new Error(`install root must be an absolute path without quotes or newlines: ${installRoot}`);
  }
  const dashboardDistRoot = resolveDashboardDistRoot(opts.dashboardDistRoot);

  const now = new Date();
  const idempotency = buildIdempotencyCommand(installRoot);
  const allLayoutCommands = buildLayoutCommands(installRoot, true, now);
  const useChunkedWrites = opts.runner === undefined;

  if (opts.dryRun === true) {
    const systemdCommands = await buildSystemdCommands(installRoot, DEFAULT_NODE_PATH);
    printDryRun(host, [
      ...SNAPSHOT_COMMANDS,
      idempotency,
      ...allLayoutCommands,
      { command: "which node", description: "resolve Node path" },
      ...systemdCommands,
      ...SNAPSHOT_COMMANDS,
    ]);
    printDryRunLocal(npmCommand(), ["run", "build:ui"]);
    printDryRunLocal("rsync", [
      "-az",
      "--delete",
      rsyncPath(dashboardDistRoot),
      `${host}:${installRoot}/dist/dashboard-ui/`,
    ]);
    return {
      host,
      installRoot,
      steps: [],
      preSnapshot: emptySnapshot(),
      postSnapshot: emptySnapshot(),
      servicesChanged: false,
      systemd: emptySystemd(DEFAULT_NODE_PATH),
    };
  }

  const runner = opts.runner ?? makeInstallVpsSshRunner();
  const localRunner = opts.localRunner ?? (opts.runner === undefined ? makeLocalCommandRunner() : null);
  const steps: InstallVpsResult["steps"] = [];
  const preSnapshot = await captureSnapshot(host, runner);
  const idempotencyResult = await runChecked(host, runner, idempotency);
  const exists = idempotencyResult.stdout.trim() === "EXISTS";
  const layoutCommands = buildLayoutCommands(installRoot, !exists, now, useChunkedWrites);

  for (const cmd of layoutCommands) {
    const result = await runChecked(host, runner, cmd);
    steps.push({
      command: cmd.command,
      description: cmd.description,
      output: result.stdout || result.stderr,
      exitCode: result.exitCode,
    });
  }

  const nodePath = await resolveNodePath(host, runner);
  if (localRunner) {
    steps.push(...await syncDashboardUiDist(host, installRoot, runner, localRunner, dashboardDistRoot));
  }
  const systemdCommands = await buildSystemdCommands(installRoot, nodePath, useChunkedWrites);
  for (const cmd of systemdCommands) {
    const result = await runChecked(host, runner, cmd);
    steps.push({
      command: cmd.command,
      description: cmd.description,
      output: result.stdout || result.stderr,
      exitCode: result.exitCode,
    });
  }

  const systemd = await verifySystemd(host, runner, nodePath);

  const postSnapshot = await captureSnapshot(host, runner);
  return {
    host,
    installRoot,
    steps,
    preSnapshot,
    postSnapshot,
    servicesChanged: snapshotChanged(preSnapshot, postSnapshot),
    systemd,
  };
}
