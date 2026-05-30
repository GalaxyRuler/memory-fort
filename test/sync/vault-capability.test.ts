import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isGitRepo } from "../../src/sync/git-repo.js";
import { getVaultWriteCapability } from "../../src/sync/vault-capability.js";
import type { CommandRunner } from "../../src/sync/git-remote.js";

function runnerReturning(stdout: string, exitCode = 0): CommandRunner {
  return {
    run: vi.fn(async () => ({ stdout, stderr: "", exitCode })),
  };
}

describe("vault write capability", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vault-capability-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("treats a vault with a .git directory as writable without shelling out", async () => {
    await mkdir(join(tmp, ".git"));
    const runner = runnerReturning("false", 1);

    await expect(isGitRepo(tmp, runner)).resolves.toBe(true);
    await expect(getVaultWriteCapability(tmp, runner)).resolves.toEqual({ writable: true });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("treats a vault with a .git file as writable when rev-parse confirms a work tree", async () => {
    await writeFile(join(tmp, ".git"), "gitdir: ../real-git-dir\n");
    const runner = runnerReturning("true\n");

    await expect(isGitRepo(tmp, runner)).resolves.toBe(true);
    await expect(getVaultWriteCapability(tmp, runner)).resolves.toEqual({ writable: true });
    expect(runner.run).toHaveBeenCalledWith("git", ["rev-parse", "--is-inside-work-tree"], { cwd: tmp });
  });

  it("marks a detached checkout without a git work tree as read-only", async () => {
    const runner = runnerReturning("false\n", 128);

    await expect(isGitRepo(tmp, runner)).resolves.toBe(false);
    await expect(getVaultWriteCapability(tmp, runner)).resolves.toEqual({
      writable: false,
      reason: "read-only mirror — run `memory dashboard` on your machine to make changes",
    });
  });
});
