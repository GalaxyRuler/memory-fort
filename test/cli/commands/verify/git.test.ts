import { describe, expect, it } from "vitest";
import {
  checkGitDurabilityConfig,
  checkGitIntegrity,
} from "../../../../src/cli/commands/verify/git.js";
import type { SshCommand, SshRunner } from "../../../../src/sync/ssh-runner.js";

describe("checkGitDurabilityConfig", () => {
  const base = {
    vaultRoot: "/v",
    now: () => new Date("2026-06-17T00:00:00.000Z"),
  };

  it("passes when core.fsync=committed", async () => {
    const execFile = async () => ({ stdout: "committed\n", stderr: "" });

    const r = await checkGitDurabilityConfig({ ...base, execFile });

    expect(r.status).toBe("pass");
  });

  it("warns when core.fsync set to something else", async () => {
    const execFile = async () => ({ stdout: "loose-object\n", stderr: "" });

    const r = await checkGitDurabilityConfig({ ...base, execFile });

    expect(r.status).toBe("warn");
  });

  it("fails when core.fsync unset", async () => {
    const execFile = async () => ({ stdout: "\n", stderr: "" });

    const r = await checkGitDurabilityConfig({ ...base, execFile });

    expect(r.status).toBe("fail");
  });
});

describe("checkGitIntegrity", () => {
  const base = {
    vaultRoot: "/v",
    now: () => new Date("2026-06-17T00:00:00.000Z"),
  };

  it("passes local and remote fsck when both repositories are clean", async () => {
    const sshRunner = makeSshRunner();

    const results = await checkGitIntegrity({
      ...base,
      execFile: async () => ({ stdout: "", stderr: "" }),
      configLoader: async () => ({
        sync: {},
        vps: { host: "example.test", install_root: "/srv/memory", ssh_user: "root" },
      }),
      sshRunner,
    });

    expect(results.map((r) => r.status)).toEqual(["pass", "pass"]);
    expect(sshRunner.calls).toHaveLength(1);
    expect(sshRunner.calls[0]?.host).toBe("root@example.test");
    expect(sshRunner.calls[0]?.command.command).toContain(
      "git -C '/srv/memory/memory.git' fsck --full --strict",
    );
  });

  it("fails local fsck and short-circuits remote fsck", async () => {
    const sshRunner = makeSshRunner();

    const results = await checkGitIntegrity({
      ...base,
      execFile: async () => {
        throw new Error("missing blob");
      },
      configLoader: async () => ({
        sync: {},
        vps: { host: "example.test", install_root: "/srv/memory" },
      }),
      sshRunner,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("fail");
    expect(results[0]?.detail).toContain("missing blob");
    expect(sshRunner.calls).toEqual([]);
  });

  it("fails remote fsck when ssh command exits non-zero", async () => {
    const sshRunner = makeSshRunner({ exitCode: 1, stderr: "broken object\n" });

    const results = await checkGitIntegrity({
      ...base,
      execFile: async () => ({ stdout: "", stderr: "" }),
      configLoader: async () => ({
        sync: {},
        vps: { host: "example.test", install_root: "/srv/memory" },
      }),
      sshRunner,
    });

    expect(results.map((r) => r.status)).toEqual(["pass", "fail"]);
    expect(results[1]?.detail).toContain("broken object");
  });

  it("fails remote fsck when git fsck emits output", async () => {
    const sshRunner = makeSshRunner({ stdout: "dangling blob abc\n" });

    const results = await checkGitIntegrity({
      ...base,
      execFile: async () => ({ stdout: "", stderr: "" }),
      configLoader: async () => ({
        sync: {},
        vps: { host: "example.test", install_root: "/srv/memory" },
      }),
      sshRunner,
    });

    expect(results.map((r) => r.status)).toEqual(["pass", "fail"]);
    expect(results[1]?.detail).toContain("dangling blob abc");
  });

  it("warns when remote fsck cannot run because vps config is incomplete", async () => {
    const sshRunner = makeSshRunner();

    const results = await checkGitIntegrity({
      ...base,
      execFile: async () => ({ stdout: "", stderr: "" }),
      configLoader: async () => ({ sync: {}, vps: { host: "example.test" } }),
      sshRunner,
    });

    expect(results.map((r) => r.status)).toEqual(["pass", "warn"]);
    expect(results[1]?.detail).toMatch(/vps config/i);
    expect(sshRunner.calls).toEqual([]);
  });

  it("skips fsck in offline mode", async () => {
    const sshRunner = makeSshRunner();

    const results = await checkGitIntegrity({
      ...base,
      offline: true,
      execFile: async () => {
        throw new Error("should not run");
      },
      sshRunner,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("warn");
    expect(results[0]?.detail).toContain("--offline");
    expect(sshRunner.calls).toEqual([]);
  });
});

interface RecordedSsh {
  host: string;
  command: SshCommand;
}

function makeSshRunner(
  result: Partial<{ stdout: string; stderr: string; exitCode: number }> = {},
): SshRunner & { calls: RecordedSsh[] } {
  const calls: RecordedSsh[] = [];
  return {
    calls,
    async run(host: string, command: SshCommand) {
      calls.push({ host, command });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
  };
}
