import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  VerifySchedulePlatformOptions,
  VerifySchedulePlatformResult,
} from "./types.js";

const LABEL = "com.memory-fort.verify";
const PLIST_NAME = `${LABEL}.plist`;
const TASK_NAME = "Memory Fort Verify";

export interface DarwinVerifyScheduleOptions extends VerifySchedulePlatformOptions {
  homeDir?: string;
}

export async function installDarwinVerifySchedule(
  opts: DarwinVerifyScheduleOptions,
): Promise<VerifySchedulePlatformResult> {
  const home = opts.homeDir ?? homedir();
  const auditDir = join(opts.memoryRoot, "wiki", ".audit");
  const scriptPath = join(auditDir, "verify-scheduled.sh");
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const plistPath = join(launchAgentsDir, PLIST_NAME);

  if (opts.action === "status") {
    try {
      const status = await opts.execFile("launchctl", ["list", LABEL]);
      return result(opts, auditDir, {
        installed: true,
        detail: status.stdout ?? "",
        scriptPath,
        plistPath,
      });
    } catch (err) {
      return result(opts, auditDir, {
        installed: false,
        detail: (err as Error).message,
        scriptPath,
        plistPath,
        exitCode: 1,
      });
    }
  }

  await unloadPlist(opts, plistPath);

  if (opts.action === "uninstall") {
    await rm(plistPath, { force: true });
    return result(opts, auditDir, {
      installed: false,
      detail: "launchd agent removed",
      scriptPath,
      plistPath,
    });
  }

  await mkdir(auditDir, { recursive: true });
  await mkdir(launchAgentsDir, { recursive: true });
  await writeFile(scriptPath, shellScript(opts.memoryCommand, auditDir), "utf-8");
  await chmod(scriptPath, 0o755);
  await writeFile(plistPath, plist(scriptPath, opts.daily ?? "09:00"), "utf-8");
  await opts.execFile("launchctl", ["load", plistPath]);

  return result(opts, auditDir, {
    installed: true,
    detail: `scheduled daily at ${opts.daily ?? "09:00"}`,
    scriptPath,
    plistPath,
  });
}

async function unloadPlist(opts: DarwinVerifyScheduleOptions, plistPath: string): Promise<void> {
  try {
    await opts.execFile("launchctl", ["unload", plistPath]);
  } catch {
    // Idempotent install/uninstall: a missing LaunchAgent is a fine pre-state.
  }
}

function result(
  opts: DarwinVerifyScheduleOptions,
  auditDir: string,
  extra: Partial<VerifySchedulePlatformResult>,
): VerifySchedulePlatformResult {
  return {
    action: opts.action,
    platform: "darwin",
    scheduler: "launchd",
    taskName: TASK_NAME,
    installed: extra.installed ?? false,
    auditDir,
    daily: opts.daily,
    detail: extra.detail,
    scriptPath: extra.scriptPath,
    plistPath: extra.plistPath,
    exitCode: extra.exitCode ?? 0,
  };
}

function plist(scriptPath: string, daily: string): string {
  const [hour, minute] = daily.split(":").map((part) => Number(part));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(LABEL)}</string>`,
    "  <!-- Runs: memory verify --json -->",
    "  <!-- Notification: osascript -->",
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/sh</string>",
    `    <string>${escapeXml(scriptPath)}</string>`,
    "  </array>",
    "  <key>StartCalendarInterval</key>",
    "  <dict>",
    "    <key>Hour</key>",
    `    <integer>${hour}</integer>`,
    "    <key>Minute</key>",
    `    <integer>${minute}</integer>`,
    "  </dict>",
    "</dict>",
    "</plist>",
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
    "  osascript -e \"display notification \\\"memory verify reported a warning or failure. See $audit_path\\\" with title \\\"Memory Fort health check\\\"\"",
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
