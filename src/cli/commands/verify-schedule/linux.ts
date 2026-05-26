import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  VerifySchedulePlatformOptions,
  VerifySchedulePlatformResult,
} from "./types.js";

const SERVICE_NAME = "memory-fort-verify.service";
const TIMER_NAME = "memory-fort-verify.timer";
const TASK_NAME = "Memory Fort Verify";

export interface LinuxVerifyScheduleOptions extends VerifySchedulePlatformOptions {
  homeDir?: string;
}

export async function installLinuxVerifySchedule(
  opts: LinuxVerifyScheduleOptions,
): Promise<VerifySchedulePlatformResult> {
  const home = opts.homeDir ?? homedir();
  const auditDir = join(opts.memoryRoot, "wiki", ".audit");
  const scriptPath = join(auditDir, "verify-scheduled.sh");
  const unitDir = join(home, ".config", "systemd", "user");
  const servicePath = join(unitDir, SERVICE_NAME);
  const timerPath = join(unitDir, TIMER_NAME);

  if (opts.action === "status") {
    try {
      const status = await opts.execFile("systemctl", ["--user", "status", TIMER_NAME]);
      return result(opts, auditDir, {
        installed: true,
        detail: status.stdout ?? "",
        scriptPath,
        servicePath,
        timerPath,
      });
    } catch (err) {
      return result(opts, auditDir, {
        installed: false,
        detail: (err as Error).message,
        scriptPath,
        servicePath,
        timerPath,
        exitCode: 1,
      });
    }
  }

  await disableTimer(opts);

  if (opts.action === "uninstall") {
    await rm(servicePath, { force: true });
    await rm(timerPath, { force: true });
    await opts.execFile("systemctl", ["--user", "daemon-reload"]);
    return result(opts, auditDir, {
      installed: false,
      detail: "systemd user timer removed",
      scriptPath,
      servicePath,
      timerPath,
    });
  }

  await mkdir(auditDir, { recursive: true });
  await mkdir(unitDir, { recursive: true });
  await writeFile(scriptPath, shellScript(opts.memoryCommand, auditDir), "utf-8");
  await chmod(scriptPath, 0o755);
  await writeFile(servicePath, serviceUnit(scriptPath), "utf-8");
  await writeFile(timerPath, timerUnit(opts.daily ?? "09:00"), "utf-8");
  await opts.execFile("systemctl", ["--user", "daemon-reload"]);
  await opts.execFile("systemctl", ["--user", "enable", "--now", TIMER_NAME]);

  return result(opts, auditDir, {
    installed: true,
    detail: `scheduled daily at ${opts.daily ?? "09:00"}`,
    scriptPath,
    servicePath,
    timerPath,
  });
}

async function disableTimer(opts: LinuxVerifyScheduleOptions): Promise<void> {
  try {
    await opts.execFile("systemctl", ["--user", "disable", "--now", TIMER_NAME]);
  } catch {
    // Idempotent install/uninstall: a missing timer is a fine pre-state.
  }
}

function result(
  opts: LinuxVerifyScheduleOptions,
  auditDir: string,
  extra: Partial<VerifySchedulePlatformResult>,
): VerifySchedulePlatformResult {
  return {
    action: opts.action,
    platform: "linux",
    scheduler: "systemd user timer",
    taskName: TASK_NAME,
    installed: extra.installed ?? false,
    auditDir,
    daily: opts.daily,
    detail: extra.detail,
    scriptPath: extra.scriptPath,
    servicePath: extra.servicePath,
    timerPath: extra.timerPath,
    exitCode: extra.exitCode ?? 0,
  };
}

function serviceUnit(scriptPath: string): string {
  return [
    "[Unit]",
    "Description=Memory Fort daily verify",
    "",
    "[Service]",
    "Type=oneshot",
    "# Runs: memory verify --json",
    "# Audit file: verify-$date.json",
    "# Notification: notify-send",
    `ExecStart=/bin/sh ${shQuote(scriptPath)}`,
    "",
  ].join("\n");
}

function timerUnit(daily: string): string {
  return [
    "[Unit]",
    "Description=Run Memory Fort verify daily",
    "",
    "[Timer]",
    `OnCalendar=*-*-* ${daily}:00`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

function shellScript(memoryCommand: string, auditDir: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `audit_dir=${shQuote(auditDir)}`,
    'mkdir -p "$audit_dir"',
    "date=$(date +%F)",
    'audit_path="$audit_dir/verify-$date.json"',
    `${shCommand(memoryCommand)} verify --json > "$audit_path"`,
    "if grep -Eq '\"overallStatus\"[[:space:]]*:[[:space:]]*\"(warn|fail)\"' \"$audit_path\"; then",
    "  if command -v notify-send >/dev/null 2>&1; then",
    "    notify-send 'Memory Fort health check' \"memory verify reported a warning or failure. See $audit_path\"",
    "  fi",
    "fi",
    "",
  ].join("\n");
}

function shCommand(command: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(command)) return command;
  return shQuote(command);
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
