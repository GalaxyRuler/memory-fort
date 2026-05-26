import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExecFile,
  VerifySchedulePlatformOptions,
  VerifySchedulePlatformResult,
} from "./types.js";

const TASK_NAME = "Memory Fort Verify";

export interface WindowsVerifyScheduleOptions extends VerifySchedulePlatformOptions {}

export async function installWindowsVerifySchedule(
  opts: WindowsVerifyScheduleOptions,
): Promise<VerifySchedulePlatformResult> {
  const auditDir = join(opts.memoryRoot, "wiki", ".audit");
  const scriptPath = join(auditDir, "verify-scheduled.ps1");

  if (opts.action === "status") {
    try {
      const status = await opts.execFile("schtasks.exe", [
        "/Query",
        "/TN",
        TASK_NAME,
        "/FO",
        "LIST",
        "/V",
      ]);
      return result(opts, auditDir, { installed: true, detail: status.stdout ?? "" });
    } catch (err) {
      return result(opts, auditDir, {
        installed: false,
        detail: (err as Error).message,
        exitCode: 1,
      });
    }
  }

  await deleteTask(opts.execFile);

  if (opts.action === "uninstall") {
    return result(opts, auditDir, {
      installed: false,
      detail: "scheduled task removed",
    });
  }

  await mkdir(auditDir, { recursive: true });
  await writeFile(scriptPath, windowsScript(opts.memoryCommand, auditDir), "utf-8");
  await opts.execFile("schtasks.exe", [
    "/Create",
    "/TN",
    TASK_NAME,
    "/SC",
    "DAILY",
    "/ST",
    opts.daily ?? "09:00",
    "/TR",
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
    "/F",
  ], { windowsHide: true });

  return result(opts, auditDir, {
    installed: true,
    detail: `scheduled daily at ${opts.daily ?? "09:00"}`,
    scriptPath,
  });
}

async function deleteTask(execFile: ExecFile): Promise<void> {
  try {
    await execFile("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"], { windowsHide: true });
  } catch {
    // Idempotent install/uninstall: absence of the task is already the desired pre-state.
  }
}

function result(
  opts: WindowsVerifyScheduleOptions,
  auditDir: string,
  extra: Partial<VerifySchedulePlatformResult>,
): VerifySchedulePlatformResult {
  return {
    action: opts.action,
    platform: "win32",
    scheduler: "Windows Task Scheduler",
    taskName: TASK_NAME,
    installed: extra.installed ?? false,
    auditDir,
    daily: opts.daily,
    exitCode: extra.exitCode ?? 0,
    detail: extra.detail,
    scriptPath: extra.scriptPath,
  };
}

function windowsScript(memoryCommand: string, auditDir: string): string {
  const command = powershellCommand(memoryCommand);
  const audit = psString(auditDir);
  return [
    "$ErrorActionPreference = 'Continue'",
    `$auditDir = ${audit}`,
    "New-Item -ItemType Directory -Force -Path $auditDir | Out-Null",
    "$date = Get-Date -Format 'yyyy-MM-dd'",
    '$auditPath = Join-Path $auditDir "verify-$date.json"',
    `${command} verify --json | Out-File -FilePath $auditPath -Encoding utf8`,
    "$report = Get-Content -Raw -Path $auditPath | ConvertFrom-Json",
    "if ($report.overallStatus -ne 'pass') {",
    "  $title = 'Memory Fort health check'",
    "  $body = \"memory verify reported $($report.overallStatus). See $auditPath\"",
    "  if (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue) {",
    "    New-BurntToastNotification -Text $title, $body",
    "  } else {",
    "    Add-Type -AssemblyName System.Windows.Forms",
    "    [System.Windows.Forms.MessageBox]::Show($body, $title) | Out-Null",
    "  }",
    "}",
    "",
  ].join("\n");
}

function powershellCommand(command: string): string {
  if (/^[A-Za-z0-9_.:-]+$/.test(command)) return `& ${command}`;
  return `& ${psString(command)}`;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
