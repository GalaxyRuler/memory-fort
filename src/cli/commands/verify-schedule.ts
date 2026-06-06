import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { memoryRoot } from "../../storage/paths.js";
import { installDarwinVerifySchedule } from "./verify-schedule/darwin.js";
import { installLinuxVerifySchedule } from "./verify-schedule/linux.js";
import type {
  ExecFile,
  VerifyScheduleAction,
  VerifySchedulePlatformResult,
  VerifyScheduleShell,
} from "./verify-schedule/types.js";
import { installWindowsVerifySchedule } from "./verify-schedule/windows.js";

export type {
  ExecFile,
  VerifyScheduleAction,
  VerifySchedulePlatformResult,
  VerifyScheduleShell,
} from "./verify-schedule/types.js";

const execFileAsync = promisify(nodeExecFile) as ExecFile;

export interface RunVerifyScheduleOptions {
  action: VerifyScheduleAction | string;
  daily?: string;
  shell?: VerifyScheduleShell | string;
  platform?: NodeJS.Platform | "win32" | "linux" | "darwin";
  memoryRoot?: string;
  memoryCommand?: string;
  execFile?: ExecFile;
}

export async function runVerifySchedule(
  opts: RunVerifyScheduleOptions,
): Promise<VerifySchedulePlatformResult> {
  const action = parseAction(opts.action);
  const daily = action === "install" ? normalizeDaily(opts.daily ?? "09:00") : opts.daily;
  const shell = parseShell(opts.shell);
  const platform = opts.platform ?? process.platform;
  const root = opts.memoryRoot ?? memoryRoot();
  const common = {
    action,
    daily,
    memoryRoot: root,
    memoryCommand: opts.memoryCommand ?? "memory",
    execFile: opts.execFile ?? execFileAsync,
  };

  if (platform === "win32") {
    if (shell && shell !== "powershell") {
      throw new Error("memory verify --schedule: Windows only supports --shell powershell");
    }
    return installWindowsVerifySchedule(common);
  }

  if (platform === "linux") {
    if (shell && shell !== "systemd") {
      throw new Error("memory verify --schedule: Linux only supports --shell systemd");
    }
    return installLinuxVerifySchedule(common);
  }

  if (platform === "darwin") {
    if (shell) {
      throw new Error("memory verify --schedule: --shell is only supported for powershell or systemd schedulers");
    }
    return installDarwinVerifySchedule(common);
  }

  throw new Error(`memory verify --schedule: unsupported platform ${platform}`);
}

export function formatVerifyScheduleResult(result: VerifySchedulePlatformResult): string {
  const state = result.installed ? "installed" : "not installed";
  const lines = [
    `memory verify schedule ${result.action}: ${state}`,
    `  scheduler: ${result.scheduler}`,
    `  task:      ${result.taskName}`,
    `  audit:     ${result.auditDir}`,
  ];
  if (result.daily) lines.push(`  daily:     ${result.daily}`);
  if (result.detail?.trim()) lines.push(`  detail:    ${result.detail.trim()}`);
  return `${lines.join("\n")}\n`;
}

function parseAction(action: VerifyScheduleAction | string): VerifyScheduleAction {
  if (action === "install" || action === "uninstall" || action === "status") return action;
  throw new Error("memory verify --schedule: use install, uninstall, or status");
}

function parseShell(shell: VerifyScheduleShell | string | undefined): VerifyScheduleShell | undefined {
  if (shell === undefined) return undefined;
  if (shell === "powershell" || shell === "systemd") return shell;
  throw new Error("memory verify --schedule: --shell must be powershell or systemd");
}

function normalizeDaily(value: string): string {
  if (!/^\d{2}:\d{2}$/.test(value)) {
    throw new Error("memory verify --schedule: --daily must be HH:MM");
  }
  const [hour, minute] = value.split(":").map((part) => Number(part));
  if (hour > 23 || minute > 59) {
    throw new Error("memory verify --schedule: --daily must be HH:MM");
  }
  return value;
}
