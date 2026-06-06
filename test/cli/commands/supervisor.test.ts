import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import {
  formatSupervisorJson,
  formatSupervisorResult,
  runInstallSupervisor,
  runSupervisorStatus,
} from "../../../src/cli/commands/supervisor.js";

const repoRoot = "memory-system-fixture";
const launcherPath = resolve(repoRoot, "scripts", "start-memory-fort.ps1");
const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const valueName = "MemoryFortDashboard";
const expectedPwshCommand = `pwsh.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcherPath}"`;
const expectedWindowsPowerShellCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcherPath}"`;

describe("supervisor commands", () => {
  it("applies the HKCU Run key when absent", async () => {
    const execFile = supervisorExec({ statusValue: undefined });

    const result = await runInstallSupervisor({
      action: "apply",
      repoRoot,
      taskName: valueName,
      execFile,
      platform: "win32",
    });

    expect(result.exitCode).toBe(0);
    expect(result.installed).toBe(true);
    expect(result.value).toBe(expectedPwshCommand);
    expect(execFile).toHaveBeenCalledWith("reg.exe", [
      "ADD",
      runKey,
      "/v",
      valueName,
      "/t",
      "REG_SZ",
      "/d",
      expectedPwshCommand,
      "/f",
    ]);
    expect(formatSupervisorResult(result)).toContain("Status: installed");
  });

  it("does not rewrite the HKCU Run key when the value already matches", async () => {
    const execFile = supervisorExec({ statusValue: expectedPwshCommand });

    const result = await runInstallSupervisor({
      action: "apply",
      repoRoot,
      execFile,
      platform: "win32",
    });

    expect(result.exitCode).toBe(0);
    expect(result.message).toBe("already installed");
    expect(execFile.mock.calls).not.toContainEqual(expect.arrayContaining(["reg.exe", expect.arrayContaining(["ADD"])]));
  });

  it("overwrites a drifted HKCU Run key on apply", async () => {
    const execFile = supervisorExec({ statusValue: "pwsh.exe -File C:\\old\\start-memory-fort.ps1" });

    const result = await runInstallSupervisor({
      action: "apply",
      repoRoot,
      execFile,
      platform: "win32",
    });

    expect(result.exitCode).toBe(0);
    expect(result.message).toBe("installed");
    expect(execFile).toHaveBeenCalledWith("reg.exe", expect.arrayContaining([
      "ADD",
      runKey,
      "/d",
      expectedPwshCommand,
      "/f",
    ]));
  });

  it("removes the HKCU Run key value when present", async () => {
    const execFile = supervisorExec({ statusValue: expectedPwshCommand });

    const result = await runInstallSupervisor({
      action: "remove",
      repoRoot,
      execFile,
      platform: "win32",
    });

    expect(result.exitCode).toBe(0);
    expect(result.installed).toBe(false);
    expect(execFile).toHaveBeenCalledWith("reg.exe", [
      "DELETE",
      runKey,
      "/v",
      valueName,
      "/f",
    ]);
  });

  it("treats remove on an absent HKCU Run key value as success", async () => {
    const execFile = supervisorExec({ statusValue: undefined, deleteMissing: true });

    const result = await runInstallSupervisor({
      action: "remove",
      repoRoot,
      execFile,
      platform: "win32",
    });

    expect(result.exitCode).toBe(0);
    expect(result.installed).toBe(false);
    expect(result.message).toBe("not installed");
  });

  it("reports status when the HKCU Run key value is absent", async () => {
    const execFile = supervisorExec({ statusValue: undefined });

    const result = await runSupervisorStatus({
      repoRoot,
      execFile,
      platform: "win32",
    });

    expect(result.exitCode).toBe(0);
    expect(result.installed).toBe(false);
    expect(result.drift).toBe(false);
    expect(result.value).toBeUndefined();
    expect(formatSupervisorResult(result)).toContain("Status: not installed");
  });

  it("reports installed status and parses the HKCU Run key value", async () => {
    const execFile = supervisorExec({ statusValue: expectedPwshCommand });

    const result = await runSupervisorStatus({
      repoRoot,
      execFile,
      platform: "win32",
    });

    expect(result.installed).toBe(true);
    expect(result.value).toBe(expectedPwshCommand);
    expect(result.actual).toBe(expectedPwshCommand);
    expect(result.expected).toBe(expectedPwshCommand);
    expect(result.drift).toBe(false);
    expect(result.shell).toBe("pwsh");
    expect(result.launcherPath).toBe(launcherPath);
  });

  it("surfaces drift when the stored HKCU Run key value does not match", async () => {
    const actual = "pwsh.exe -File C:\\old\\start-memory-fort.ps1";
    const execFile = supervisorExec({ statusValue: actual });

    const result = await runSupervisorStatus({
      repoRoot,
      execFile,
      platform: "win32",
    });

    expect(result.installed).toBe(true);
    expect(result.drift).toBe(true);
    expect(result.actual).toBe(actual);
    expect(result.expected).toBe(expectedPwshCommand);
    expect(formatSupervisorResult(result)).toContain("Drift: yes");
  });

  it("falls back to powershell.exe when pwsh.exe is absent", async () => {
    const execFile = supervisorExec({
      statusValue: expectedWindowsPowerShellCommand,
      pwshAvailable: false,
    });

    const result = await runSupervisorStatus({
      repoRoot,
      execFile,
      platform: "win32",
    });

    expect(result.installed).toBe(true);
    expect(result.shell).toBe("powershell");
    expect(result.expected).toBe(expectedWindowsPowerShellCommand);
    expect(result.drift).toBe(false);
  });

  it("formats structured JSON status", async () => {
    const execFile = supervisorExec({ statusValue: expectedPwshCommand });
    const result = await runSupervisorStatus({
      repoRoot,
      execFile,
      platform: "win32",
    });

    expect(JSON.parse(formatSupervisorJson(result))).toMatchObject({
      action: "status",
      installed: true,
      taskName: valueName,
      shell: "pwsh",
      launcherPath,
      value: expectedPwshCommand,
      drift: false,
    });
  });
});

function supervisorExec(opts: {
  statusValue?: string;
  pwshAvailable?: boolean;
  deleteMissing?: boolean;
}) {
  const execFile = vi.fn(async (file: string, args: string[]) => {
    if (file === "where.exe" && args[0] === "pwsh.exe") {
      if (opts.pwshAvailable === false) throw missingExecutable("pwsh.exe");
      return { stdout: "C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n", stderr: "" };
    }
    if (file === "where.exe" && args[0] === "powershell.exe") {
      return {
        stdout: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n",
        stderr: "",
      };
    }
    if (file === "reg.exe" && args[0] === "QUERY") {
      if (opts.statusValue === undefined) throw missingRegistryValue();
      return {
        stdout: [
          "",
          `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`,
          `    ${valueName}    REG_SZ    ${opts.statusValue}`,
          "",
        ].join("\r\n"),
        stderr: "",
      };
    }
    if (file === "reg.exe" && args[0] === "ADD") {
      return { stdout: "The operation completed successfully.\r\n", stderr: "" };
    }
    if (file === "reg.exe" && args[0] === "DELETE") {
      if (opts.deleteMissing) throw missingRegistryValue();
      return { stdout: "The operation completed successfully.\r\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  return execFile;
}

function missingExecutable(name: string): Error {
  return new Error(`INFO: Could not find files for the given pattern(s): ${name}`);
}

function missingRegistryValue(): Error {
  return new Error("ERROR: The system was unable to find the specified registry key or value.");
}
