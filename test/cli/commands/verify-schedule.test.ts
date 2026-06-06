import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatVerifyScheduleResult,
  runVerifySchedule,
} from "../../../src/cli/commands/verify-schedule.js";
import { installDarwinVerifySchedule } from "../../../src/cli/commands/verify-schedule/darwin.js";
import { installLinuxVerifySchedule } from "../../../src/cli/commands/verify-schedule/linux.js";
import { installWindowsVerifySchedule } from "../../../src/cli/commands/verify-schedule/windows.js";

interface ExecCall {
  command: string;
  args: string[];
}

describe("runVerifySchedule", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("installs the native platform scheduler with the audit directory in the result", async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-verify-schedule-"));
    const calls: ExecCall[] = [];

    const result = await runVerifySchedule({
      action: "install",
      daily: "07:45",
      platform: "win32",
      memoryRoot: tmp,
      execFile: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "ok", stderr: "" };
      },
    });

    expect(result.installed).toBe(true);
    expect(result.auditDir).toBe(join(tmp, "wiki", ".audit"));
    expect(calls.map((call) => call.args[0])).toEqual(["/Delete", "/Create"]);
    expect(formatVerifyScheduleResult(result)).toContain("installed");
  });

  it("rejects malformed daily times before touching the scheduler", async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-verify-schedule-"));
    const calls: ExecCall[] = [];

    await expect(runVerifySchedule({
      action: "install",
      daily: "25:99",
      platform: "win32",
      memoryRoot: tmp,
      execFile: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    })).rejects.toThrow(/HH:MM/);

    expect(calls).toHaveLength(0);
  });
});

describe("platform verify schedulers", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("creates an idempotent Windows scheduled task with BurntToast and MessageBox fallback", async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-verify-schedule-"));
    const calls: ExecCall[] = [];

    const result = await installWindowsVerifySchedule({
      action: "install",
      daily: "09:15",
      memoryRoot: tmp,
      memoryCommand: "memory",
      execFile: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "ok", stderr: "" };
      },
    });

    const script = await readFile(result.scriptPath!, "utf-8");
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe("schtasks.exe");
    expect(calls[0].args[0]).toBe("/Delete");
    expect(calls[0].args).toContain("Memory Fort Verify");
    expect(calls[1].args).toContain("/Create");
    expect(calls[1].args).toContain("/ST");
    expect(calls[1].args).toContain("09:15");
    expect(script).toContain("memory verify --json");
    expect(script).toContain("verify-$date.json");
    expect(script).toContain("New-BurntToastNotification");
    expect(script).toContain("System.Windows.Forms.MessageBox");
  });

  it("creates systemd user units that run verify and notify via notify-send", async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-verify-schedule-"));
    const calls: ExecCall[] = [];

    const result = await installLinuxVerifySchedule({
      action: "install",
      daily: "06:05",
      memoryRoot: tmp,
      homeDir: tmp,
      memoryCommand: "memory",
      execFile: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "ok", stderr: "" };
      },
    });

    const service = await readFile(result.servicePath!, "utf-8");
    const timer = await readFile(result.timerPath!, "utf-8");
    expect(calls.some((call) => call.args.includes("disable"))).toBe(true);
    expect(calls.some((call) => call.args.includes("enable") && call.args.includes("--now"))).toBe(true);
    expect(service).toContain("memory verify --json");
    expect(service).toContain("notify-send");
    expect(service).toContain("verify-$date.json");
    expect(timer).toContain("OnCalendar=*-*-* 06:05:00");
  });

  it("creates a launchd plist that runs verify and notifies via osascript", async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-verify-schedule-"));
    const calls: ExecCall[] = [];

    const result = await installDarwinVerifySchedule({
      action: "install",
      daily: "21:30",
      memoryRoot: tmp,
      homeDir: tmp,
      memoryCommand: "memory",
      execFile: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "ok", stderr: "" };
      },
    });

    const plist = await readFile(result.plistPath!, "utf-8");
    expect(calls.some((call) => call.args.includes("unload"))).toBe(true);
    expect(calls.some((call) => call.args.includes("load"))).toBe(true);
    expect(plist).toContain("memory verify --json");
    expect(plist).toContain("osascript");
    expect(plist).toContain("<key>Hour</key>");
    expect(plist).toContain("<integer>21</integer>");
    expect(plist).toContain("<integer>30</integer>");
  });
});
