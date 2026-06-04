import { describe, expect, it, vi } from "vitest";
import {
  formatSupervisorResult,
  runInstallSupervisor,
  runSupervisorStatus,
} from "../../../src/cli/commands/supervisor.js";

describe("supervisor commands", () => {
  it("installs an idempotent logon task through schtasks", async () => {
    const execFile = vi.fn(async () => ({ stdout: "SUCCESS", stderr: "" }));

    const result = await runInstallSupervisor({
      action: "apply",
      repoRoot: "C:\\CodexProjects\\memory-system",
      taskName: "MemoryFortDashboard",
      execFile,
      platform: "win32",
    });

    expect(result.exitCode).toBe(0);
    expect(execFile).toHaveBeenCalledWith("schtasks.exe", expect.arrayContaining([
      "/Create",
      "/SC",
      "ONLOGON",
      "/TN",
      "MemoryFortDashboard",
      "/F",
    ]));
    expect(JSON.stringify(execFile.mock.calls)).toContain("start-memory-fort.ps1");
    expect(formatSupervisorResult(result)).toContain("installed");
  });

  it("removes the logon task without treating missing task as success-only noise", async () => {
    const execFile = vi.fn(async () => ({ stdout: "SUCCESS", stderr: "" }));

    const result = await runInstallSupervisor({
      action: "remove",
      repoRoot: "C:\\CodexProjects\\memory-system",
      execFile,
      platform: "win32",
    });

    expect(result.exitCode).toBe(0);
    expect(execFile).toHaveBeenCalledWith("schtasks.exe", expect.arrayContaining([
      "/Delete",
      "/TN",
      "MemoryFortDashboard",
      "/F",
    ]));
  });

  it("queries supervisor status through schtasks", async () => {
    const execFile = vi.fn(async () => ({ stdout: "TaskName: MemoryFortDashboard", stderr: "" }));

    const result = await runSupervisorStatus({
      execFile,
      platform: "win32",
    });

    expect(result.installed).toBe(true);
    expect(formatSupervisorResult(result)).toContain("installed");
  });
});
