import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFilePromise = promisify(execFileCallback);
const DEFAULT_TASK_NAME = "MemoryFortDashboard";

export type SupervisorAction = "apply" | "remove" | "status";

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
  stdout?: string;
  stderr?: string;
}

export async function runInstallSupervisor(
  opts: SupervisorOptions = {},
): Promise<SupervisorResult> {
  const action = opts.action ?? "apply";
  if (action === "status") return runSupervisorStatus(opts);
  const platform = opts.platform ?? process.platform;
  const taskName = opts.taskName ?? DEFAULT_TASK_NAME;
  if (platform !== "win32") {
    return {
      exitCode: 1,
      action,
      installed: false,
      taskName,
      message: "Windows Task Scheduler supervisor is only supported on Windows",
    };
  }
  const execFile = opts.execFile ?? defaultExecFile;
  const args = action === "apply"
    ? createTaskArgs(opts.repoRoot ?? process.cwd(), taskName)
    : ["/Delete", "/TN", taskName, "/F"];
  const output = await execFile("schtasks.exe", args);
  return {
    exitCode: 0,
    action,
    installed: action === "apply",
    taskName,
    message: action === "apply" ? "installed" : "removed",
    stdout: output.stdout,
    stderr: output.stderr,
  };
}

export async function runSupervisorStatus(
  opts: SupervisorOptions = {},
): Promise<SupervisorResult> {
  const platform = opts.platform ?? process.platform;
  const taskName = opts.taskName ?? DEFAULT_TASK_NAME;
  if (platform !== "win32") {
    return {
      exitCode: 1,
      action: "status",
      installed: false,
      taskName,
      message: "Windows Task Scheduler supervisor is only supported on Windows",
    };
  }
  const execFile = opts.execFile ?? defaultExecFile;
  try {
    const output = await execFile("schtasks.exe", ["/Query", "/TN", taskName, "/FO", "LIST"]);
    return {
      exitCode: 0,
      action: "status",
      installed: true,
      taskName,
      message: "installed",
      stdout: output.stdout,
      stderr: output.stderr,
    };
  } catch (error) {
    return {
      exitCode: 0,
      action: "status",
      installed: false,
      taskName,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatSupervisorResult(result: SupervisorResult): string {
  const lines = [
    `Task: ${result.taskName}`,
    `Status: ${result.installed ? "installed" : "not installed"}`,
    `Action: ${result.action}`,
    `Message: ${result.message}`,
  ];
  return `${lines.join("\n")}\n`;
}

function createTaskArgs(repoRoot: string, taskName: string): string[] {
  const scriptPath = resolve(repoRoot, "scripts", "start-memory-fort.ps1");
  const taskRun = [
    "pwsh.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    quoteForTaskRun(scriptPath),
  ].join(" ");
  return [
    "/Create",
    "/SC",
    "ONLOGON",
    "/TN",
    taskName,
    "/TR",
    taskRun,
    "/RL",
    "LIMITED",
    "/F",
  ];
}

function quoteForTaskRun(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function defaultExecFile(file: string, args: string[]): Promise<SupervisorExecResult> {
  const result = await execFilePromise(file, args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
