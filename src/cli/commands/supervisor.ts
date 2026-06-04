import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFilePromise = promisify(execFileCallback);
const DEFAULT_VALUE_NAME = "MemoryFortDashboard";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export type SupervisorAction = "apply" | "remove" | "status";
export type SupervisorShell = "pwsh" | "powershell";

export interface SupervisorExecResult {
  stdout: string;
  stderr: string;
}

export interface SupervisorOptions {
  action?: SupervisorAction;
  repoRoot?: string;
  taskName?: string;
  execFile?: (file: string, args: string[]) => Promise<SupervisorExecResult>;
  platform?: NodeJS.Platform;
}

export interface SupervisorResult {
  exitCode: number;
  action: SupervisorAction;
  installed: boolean;
  taskName: string;
  message: string;
  registryKey?: string;
  value?: string;
  expected?: string;
  actual?: string;
  drift?: boolean;
  shell?: SupervisorShell;
  shellPath?: string;
  launcherPath?: string;
  stdout?: string;
  stderr?: string;
}

interface SupervisorCommand {
  valueName: string;
  registryKey: string;
  shell: SupervisorShell;
  shellPath?: string;
  launcherPath: string;
  value: string;
}

export async function runInstallSupervisor(
  opts: SupervisorOptions = {},
): Promise<SupervisorResult> {
  const action = opts.action ?? "apply";
  if (action === "status") return runSupervisorStatus(opts);
  const platform = opts.platform ?? process.platform;
  const valueName = opts.taskName ?? DEFAULT_VALUE_NAME;
  if (platform !== "win32") {
    return unsupportedWindowsResult(action, valueName);
  }

  const execFile = opts.execFile ?? defaultExecFile;
  const command = await buildSupervisorCommand(opts.repoRoot ?? process.cwd(), valueName, execFile);

  if (action === "remove") {
    try {
      const output = await execFile("reg.exe", deleteRunKeyArgs(command));
      return supervisorResult(command, {
        action,
        installed: false,
        message: "removed",
        stdout: output.stdout,
        stderr: output.stderr,
      });
    } catch (error) {
      if (!isMissingRegistryValue(error)) throw error;
      return supervisorResult(command, {
        action,
        installed: false,
        message: "not installed",
      });
    }
  }

  const status = await readSupervisorStatus(command, execFile);
  if (status.installed && !status.drift) {
    return {
      ...status,
      action,
      message: "already installed",
    };
  }

  const output = await execFile("reg.exe", addRunKeyArgs(command));
  return supervisorResult(command, {
    action,
    installed: true,
    message: "installed",
    value: command.value,
    expected: command.value,
    actual: command.value,
    drift: false,
    stdout: output.stdout,
    stderr: output.stderr,
  });
}

export async function runSupervisorStatus(
  opts: SupervisorOptions = {},
): Promise<SupervisorResult> {
  const platform = opts.platform ?? process.platform;
  const valueName = opts.taskName ?? DEFAULT_VALUE_NAME;
  if (platform !== "win32") {
    return unsupportedWindowsResult("status", valueName);
  }

  const execFile = opts.execFile ?? defaultExecFile;
  const command = await buildSupervisorCommand(opts.repoRoot ?? process.cwd(), valueName, execFile);
  return readSupervisorStatus(command, execFile);
}

export function formatSupervisorResult(result: SupervisorResult): string {
  const lines = [
    `Task: ${result.taskName}`,
    `Status: ${result.installed ? "installed" : "not installed"}`,
    `Action: ${result.action}`,
    `Message: ${result.message}`,
  ];
  if (result.registryKey) lines.push(`Registry: ${result.registryKey}`);
  if (result.shell) lines.push(`Shell: ${result.shell}`);
  if (result.launcherPath) lines.push(`Launcher: ${result.launcherPath}`);
  if (result.value) lines.push(`Value: ${result.value}`);
  if (result.drift !== undefined) lines.push(`Drift: ${result.drift ? "yes" : "no"}`);
  if (result.drift) {
    if (result.expected) lines.push(`Expected: ${result.expected}`);
    if (result.actual) lines.push(`Actual: ${result.actual}`);
    lines.push("Remediation: run `memory install supervisor --apply` to overwrite the drifted Run key value.");
  }
  return `${lines.join("\n")}\n`;
}

export function formatSupervisorJson(result: SupervisorResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

async function readSupervisorStatus(
  command: SupervisorCommand,
  execFile: NonNullable<SupervisorOptions["execFile"]>,
): Promise<SupervisorResult> {
  try {
    const output = await execFile("reg.exe", queryRunKeyArgs(command));
    const actual = parseRunKeyValue(output.stdout, command.valueName);
    if (actual === undefined) {
      return supervisorResult(command, {
        action: "status",
        installed: false,
        message: "not installed",
        drift: false,
        stdout: output.stdout,
        stderr: output.stderr,
      });
    }
    const drift = actual !== command.value;
    return supervisorResult(command, {
      action: "status",
      installed: true,
      message: drift ? "installed with drift" : "installed",
      value: actual,
      expected: command.value,
      actual,
      drift,
      stdout: output.stdout,
      stderr: output.stderr,
    });
  } catch (error) {
    if (!isMissingRegistryValue(error)) throw error;
    return supervisorResult(command, {
      action: "status",
      installed: false,
      message: "not installed",
      drift: false,
    });
  }
}

async function buildSupervisorCommand(
  repoRoot: string,
  valueName: string,
  execFile: NonNullable<SupervisorOptions["execFile"]>,
): Promise<SupervisorCommand> {
  const shell = await resolveSupervisorShell(execFile);
  const launcherPath = resolve(repoRoot, "scripts", "start-memory-fort.ps1");
  const value = [
    shell.executable,
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    quoteCommandArgument(launcherPath),
  ].join(" ");
  return {
    valueName,
    registryKey: RUN_KEY,
    shell: shell.shell,
    shellPath: shell.path,
    launcherPath,
    value,
  };
}

async function resolveSupervisorShell(
  execFile: NonNullable<SupervisorOptions["execFile"]>,
): Promise<{ shell: SupervisorShell; executable: string; path?: string }> {
  try {
    const output = await execFile("where.exe", ["pwsh.exe"]);
    return {
      shell: "pwsh",
      executable: "pwsh.exe",
      path: firstOutputLine(output.stdout),
    };
  } catch {
    try {
      const output = await execFile("where.exe", ["powershell.exe"]);
      return {
        shell: "powershell",
        executable: "powershell.exe",
        path: firstOutputLine(output.stdout),
      };
    } catch {
      return {
        shell: "powershell",
        executable: "powershell.exe",
      };
    }
  }
}

function addRunKeyArgs(command: SupervisorCommand): string[] {
  return [
    "ADD",
    command.registryKey,
    "/v",
    command.valueName,
    "/t",
    "REG_SZ",
    "/d",
    command.value,
    "/f",
  ];
}

function deleteRunKeyArgs(command: SupervisorCommand): string[] {
  return [
    "DELETE",
    command.registryKey,
    "/v",
    command.valueName,
    "/f",
  ];
}

function queryRunKeyArgs(command: SupervisorCommand): string[] {
  return [
    "QUERY",
    command.registryKey,
    "/v",
    command.valueName,
  ];
}

function supervisorResult(
  command: SupervisorCommand,
  result: Omit<SupervisorResult, "taskName" | "registryKey" | "shell" | "shellPath" | "launcherPath" | "exitCode"> & {
    exitCode?: number;
  },
): SupervisorResult {
  return {
    exitCode: result.exitCode ?? 0,
    taskName: command.valueName,
    registryKey: command.registryKey,
    shell: command.shell,
    shellPath: command.shellPath,
    launcherPath: command.launcherPath,
    ...result,
  };
}

function unsupportedWindowsResult(action: SupervisorAction, valueName: string): SupervisorResult {
  return {
    exitCode: 1,
    action,
    installed: false,
    taskName: valueName,
    message: "Windows HKCU Run-key supervisor is only supported on Windows",
  };
}

function parseRunKeyValue(stdout: string, valueName: string): string | undefined {
  const valuePattern = new RegExp(`^\\s*${escapeRegExp(valueName)}\\s+REG_[A-Z0-9_]+\\s+(.*)$`, "i");
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(valuePattern);
    if (match) return match[1]?.trimEnd();
  }
  return undefined;
}

function quoteCommandArgument(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function firstOutputLine(stdout: string): string | undefined {
  return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function isMissingRegistryValue(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return text.includes("unable to find the specified registry key or value")
    || text.includes("the system cannot find the file specified")
    || text.includes("cannot find")
    || text.includes("not found");
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const parts = [
    "message" in error ? String(error.message) : "",
    "stdout" in error ? String(error.stdout) : "",
    "stderr" in error ? String(error.stderr) : "",
  ];
  return parts.filter(Boolean).join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function defaultExecFile(file: string, args: string[]): Promise<SupervisorExecResult> {
  const result = await execFilePromise(file, args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}
