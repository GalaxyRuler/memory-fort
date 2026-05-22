import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { configPath } from "../../storage/paths.js";
import { makeRealSshRunner, type SshCommand, type SshRunner } from "../../sync/ssh-runner.js";

export interface InstallVpsOptions {
  sshHost?: string;
  installRoot?: string;
  dryRun?: boolean;
  runner?: SshRunner;
}

export interface InstallVpsResult {
  host: string;
  installRoot: string;
  steps: Array<{ command: string; description: string; output: string; exitCode: number }>;
  preSnapshot: { tailscaleServe: string; listening: string; caddyStatus: string };
  postSnapshot: { tailscaleServe: string; listening: string; caddyStatus: string };
  servicesChanged: boolean;
}

interface Snapshot {
  tailscaleServe: string;
  listening: string;
  caddyStatus: string;
}

const DEFAULT_HOST = "srv1317946";
const DEFAULT_INSTALL_ROOT = "/root/memory-system";

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

function buildInstallInfoCommand(installRoot: string, now: Date): SshCommand {
  const info = JSON.stringify(
    {
      installed_at: now.toISOString(),
      installed_by: "memory install-vps",
      version: "0.3.0-phase3-dev",
      install_root: installRoot,
    },
    null,
    2,
  );
  return {
    command: `cat > ${installRoot}/install-info.json <<EOF\n${info}\nEOF`,
    description: "write install-info.json",
  };
}

function buildLayoutCommands(installRoot: string, includeMkdir: boolean, now: Date): SshCommand[] {
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
    buildInstallInfoCommand(installRoot, now),
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
  return a.tailscaleServe !== b.tailscaleServe || a.listening !== b.listening || a.caddyStatus !== b.caddyStatus;
}

async function runChecked(host: string, runner: SshRunner, cmd: SshCommand) {
  const result = await runner.run(host, cmd);
  if (result.exitCode !== 0 && cmd.allowNonZeroExit !== true) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`SSH command failed (${cmd.description}): ${cmd.command}: ${detail}`);
  }
  return result;
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

export async function runInstallVps(opts: InstallVpsOptions = {}): Promise<InstallVpsResult> {
  const host = opts.sshHost ?? (await readConfiguredHost()) ?? DEFAULT_HOST;
  const installRoot = opts.installRoot ?? DEFAULT_INSTALL_ROOT;
  if (!isSafeRemotePath(installRoot)) {
    throw new Error(`install root must be an absolute path without quotes or newlines: ${installRoot}`);
  }

  const now = new Date();
  const idempotency = buildIdempotencyCommand(installRoot);
  const allLayoutCommands = buildLayoutCommands(installRoot, true, now);

  if (opts.dryRun === true) {
    printDryRun(host, [...SNAPSHOT_COMMANDS, idempotency, ...allLayoutCommands, ...SNAPSHOT_COMMANDS]);
    return {
      host,
      installRoot,
      steps: [],
      preSnapshot: emptySnapshot(),
      postSnapshot: emptySnapshot(),
      servicesChanged: false,
    };
  }

  const runner = opts.runner ?? makeRealSshRunner();
  const steps: InstallVpsResult["steps"] = [];
  const preSnapshot = await captureSnapshot(host, runner);
  const idempotencyResult = await runChecked(host, runner, idempotency);
  const exists = idempotencyResult.stdout.trim() === "EXISTS";
  const layoutCommands = buildLayoutCommands(installRoot, !exists, now);

  for (const cmd of layoutCommands) {
    const result = await runChecked(host, runner, cmd);
    steps.push({
      command: cmd.command,
      description: cmd.description,
      output: result.stdout || result.stderr,
      exitCode: result.exitCode,
    });
  }

  const postSnapshot = await captureSnapshot(host, runner);
  return {
    host,
    installRoot,
    steps,
    preSnapshot,
    postSnapshot,
    servicesChanged: snapshotChanged(preSnapshot, postSnapshot),
  };
}
