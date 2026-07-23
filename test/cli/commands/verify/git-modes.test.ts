import { describe, expect, it } from "vitest";
import {
  checkGitIntegrity,
  gitIntegrityCheck,
} from "../../../../src/cli/commands/verify/git.js";
import type { SshCommand, SshRunner } from "../../../../src/sync/ssh-runner.js";

const base = {
  vaultRoot: "/v",
  now: () => new Date("2026-07-23T00:00:00.000Z"),
  configLoader: async () => ({
    sync: {},
    vps: { host: "example.test", install_root: "/srv/memory", ssh_user: "root" },
  }),
};

describe("Git integrity verification modes", () => {
  it("labels the default check as connectivity-only without claiming no corruption", async () => {
    const calls: Array<{ args: string[]; timeout: number }> = [];
    const sshRunner = makeSshRunner();

    const results = await checkGitIntegrity({
      ...base,
      execFile: async (_file, args, opts) => {
        calls.push({ args, timeout: opts.timeout });
        return { stdout: "", stderr: "" };
      },
      sshRunner,
    });

    expect(gitIntegrityCheck.label.toLowerCase()).not.toContain("no corruption");
    expect(calls).toEqual([{
      args: ["fsck", "--full", "--connectivity-only", "--no-dangling"],
      timeout: 30_000,
    }]);
    expect(sshRunner.calls[0]?.command.command).toContain(
      "fsck --full --connectivity-only --no-dangling",
    );
    for (const result of results) {
      expect(result.label.toLowerCase()).not.toContain("no corruption");
      expect(result.detail).toMatch(/connectivity-only|not rehashed/i);
    }
  });

  it("rehashes local and remote objects with strict fsck in deep mode", async () => {
    const calls: Array<{ args: string[]; timeout: number }> = [];
    const sshRunner = makeSshRunner();

    const results = await checkGitIntegrity({
      ...base,
      deep: true,
      execFile: async (_file, args, opts) => {
        calls.push({ args, timeout: opts.timeout });
        return { stdout: "", stderr: "" };
      },
      sshRunner,
    });

    expect(calls).toEqual([{
      args: ["fsck", "--full", "--strict", "--no-dangling"],
      timeout: 300_000,
    }]);
    expect(sshRunner.calls[0]?.command.command).toContain(
      "fsck --full --strict --no-dangling",
    );
    expect(sshRunner.calls[0]?.command.command).not.toContain("--connectivity-only");
    expect(results.map((result) => result.status)).toEqual(["pass", "pass"]);
    expect(results.every((result) => /object integrity verified/i.test(result.label))).toBe(true);
  });

  it("uses truthful wording when deep verification is skipped offline", async () => {
    const results = await checkGitIntegrity({
      ...base,
      deep: true,
      offline: true,
      execFile: async () => {
        throw new Error("should not run");
      },
      sshRunner: makeSshRunner(),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.label).toMatch(/integrity check skipped/i);
    expect(results[0]?.label.toLowerCase()).not.toContain("no corruption");
  });
});

interface RecordedSsh {
  host: string;
  command: SshCommand;
}

function makeSshRunner(): SshRunner & { calls: RecordedSsh[] } {
  const calls: RecordedSsh[] = [];
  return {
    calls,
    async run(host, command) {
      calls.push({ host, command });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}
