import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitVaultChange } from "../../src/sync/commit-vault-change.js";
import type { CommandRunner } from "../../src/sync/git-remote.js";

const execFile = promisify(nodeExecFile);

interface RecordedCall {
  cmd: string;
  args: string[];
  cwd?: string;
}

function makeRunner(handler: (call: RecordedCall) => { stdout?: string; stderr?: string; exitCode?: number }) {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = {
    async run(cmd, args, opts) {
      const call = { cmd, args, cwd: opts?.cwd };
      calls.push(call);
      const result = handler(call);
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
  };
  return { runner, calls };
}

describe("commitVaultChange", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "commit-vault-change-"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns no-changes without adding or committing when explicit paths are clean", async () => {
    const { runner, calls } = makeRunner((call) => {
      if (call.args.join(" ") === "status --porcelain -- wiki/threads/a.md") return { stdout: "" };
      throw new Error(`unexpected command: ${call.args.join(" ")}`);
    });

    await expect(commitVaultChange({
      memoryRoot: tmp,
      paths: ["wiki/threads/a.md"],
      message: "promote thread: a",
      runner,
      scheduleAutoPush: async () => ({ scheduled: true, token: "unused" }),
    })).resolves.toEqual({ kind: "no-changes" });

    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "status --porcelain -- wiki/threads/a.md",
    ]);
  });

  it("adds only explicit paths, commits them, and schedules auto-push", async () => {
    const scheduled: string[] = [];
    const { runner, calls } = makeRunner((call) => {
      const args = call.args.join(" ");
      if (args === "status --porcelain -- wiki/threads/a.md wiki/threads-proposed/a.md") {
        return { stdout: "A  wiki/threads/a.md\n D wiki/threads-proposed/a.md\n" };
      }
      if (args === "add -A -- wiki/threads/a.md wiki/threads-proposed/a.md") return {};
      if (args === "commit -m promote thread: a") return { stdout: "[main abc1234] promote thread: a\n" };
      throw new Error(`unexpected command: ${args}`);
    });

    await expect(commitVaultChange({
      memoryRoot: tmp,
      paths: ["wiki/threads/a.md", "wiki/threads-proposed/a.md"],
      message: "promote thread: a",
      runner,
      scheduleAutoPush: async ({ memoryRoot }) => {
        scheduled.push(memoryRoot ?? "");
        return { scheduled: true, token: "tok" };
      },
    })).resolves.toEqual({ kind: "committed", commitSha: "abc1234" });

    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "status --porcelain -- wiki/threads/a.md wiki/threads-proposed/a.md",
      "add -A -- wiki/threads/a.md wiki/threads-proposed/a.md",
      "commit -m promote thread: a",
    ]);
    expect(scheduled).toEqual([tmp]);
  });

  it("logs and returns failed when git commit fails", async () => {
    const { runner } = makeRunner((call) => {
      const args = call.args.join(" ");
      if (args === "status --porcelain -- wiki/entity-merges-proposed.json") {
        return { stdout: " M wiki/entity-merges-proposed.json\n" };
      }
      if (args === "add -A -- wiki/entity-merges-proposed.json") return {};
      if (args === "commit -m reject entity: x") return { exitCode: 1, stderr: "nothing added" };
      throw new Error(`unexpected command: ${args}`);
    });

    const result = await commitVaultChange({
      memoryRoot: tmp,
      paths: ["wiki/entity-merges-proposed.json"],
      message: "reject entity: x",
      runner,
      scheduleAutoPush: async () => ({ scheduled: true, token: "unused" }),
      now: () => new Date("2026-05-28T12:00:00.000Z"),
    });

    expect(result).toEqual({
      kind: "failed",
      error: "git commit failed: nothing added",
    });
    await expect(readFile(join(tmp, "errors.log"), "utf-8")).resolves.toContain(
      "[2026-05-28T12:00:00.000Z] commit-vault-change failed | reject entity: x | git commit failed: nothing added",
    );
  });

  it("commits an untracked-source move without staging the absent old path", async () => {
    await initGitRepo(tmp);
    await mkdir(join(tmp, "wiki", "threads-proposed"), { recursive: true });
    await mkdir(join(tmp, "wiki", "threads"), { recursive: true });
    await writeFile(join(tmp, "wiki", "threads-proposed", "move-me.md"), "draft\n", "utf-8");
    await rename(
      join(tmp, "wiki", "threads-proposed", "move-me.md"),
      join(tmp, "wiki", "threads", "move-me.md"),
    );

    await expect(commitVaultChange({
      memoryRoot: tmp,
      paths: ["wiki/threads-proposed/move-me.md", "wiki/threads/move-me.md"],
      message: "promote thread: move-me",
      scheduleAutoPush: async () => ({ scheduled: true, token: "unused" }),
    })).resolves.toMatchObject({ kind: "committed" });

    await expect(git(["status", "--porcelain", "--", "wiki/threads-proposed/move-me.md", "wiki/threads/move-me.md"], tmp))
      .resolves.toBe("");
    await expect(git(["log", "-1", "--pretty=%s"], tmp)).resolves.toBe("promote thread: move-me");
  });

  it("commits a tracked-source move by staging deletion and destination", async () => {
    await initGitRepo(tmp);
    await mkdir(join(tmp, "wiki", "threads-proposed"), { recursive: true });
    await mkdir(join(tmp, "wiki", "threads"), { recursive: true });
    await writeFile(join(tmp, "wiki", "threads-proposed", "tracked.md"), "draft\n", "utf-8");
    await git(["add", "--", "wiki/threads-proposed/tracked.md"], tmp);
    await git(["commit", "-m", "seed tracked proposal"], tmp);
    await rename(
      join(tmp, "wiki", "threads-proposed", "tracked.md"),
      join(tmp, "wiki", "threads", "tracked.md"),
    );

    await expect(commitVaultChange({
      memoryRoot: tmp,
      paths: ["wiki/threads-proposed/tracked.md", "wiki/threads/tracked.md"],
      message: "promote thread: tracked",
      scheduleAutoPush: async () => ({ scheduled: true, token: "unused" }),
    })).resolves.toMatchObject({ kind: "committed" });

    await expect(git(["status", "--porcelain", "--", "wiki/threads-proposed/tracked.md", "wiki/threads/tracked.md"], tmp))
      .resolves.toBe("");
    const nameStatus = await git(["show", "--name-status", "--pretty=", "HEAD"], tmp);
    expect(nameStatus).toContain("wiki/threads-proposed/tracked.md");
    expect(nameStatus).toContain("wiki/threads/tracked.md");
  });

  it("returns no-changes when every explicit path is absent and untracked", async () => {
    await initGitRepo(tmp);

    await expect(commitVaultChange({
      memoryRoot: tmp,
      paths: ["wiki/threads-proposed/missing.md", "wiki/threads/missing.md"],
      message: "promote thread: missing",
      scheduleAutoPush: async () => {
        throw new Error("should not schedule");
      },
    })).resolves.toEqual({ kind: "no-changes" });

    await expect(git(["status", "--porcelain"], tmp)).resolves.toBe("");
  });
});

async function initGitRepo(cwd: string): Promise<void> {
  await git(["init"], cwd);
  await git(["config", "user.name", "Test User"], cwd);
  await git(["config", "user.email", "test@example.com"], cwd);
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFile("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}
