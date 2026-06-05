import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "../../../src/cli/commands/sync.js";
import { writeSyncStateFile } from "../../../src/sync/status.js";
import type { CommandRunner } from "../../../src/sync/git-remote.js";

interface RecordedCommand {
  cmd: string;
  args: string[];
  opts?: { cwd?: string; stdin?: string };
}

function makeRunner(
  handler: (call: RecordedCommand, index: number) => { stdout?: string; stderr?: string; exitCode?: number },
): CommandRunner & { calls: RecordedCommand[] } {
  const calls: RecordedCommand[] = [];
  return {
    calls,
    async run(cmd: string, args: string[], opts?: { cwd?: string; stdin?: string }) {
      const call = { cmd, args, opts };
      calls.push(call);
      const result = handler(call, calls.length - 1);
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
  };
}

function commandLine(call: RecordedCommand): string {
  return [call.cmd, ...call.args].join(" ");
}

function isRevList(call: RecordedCommand): boolean {
  return call.args.includes("rev-list");
}

function isPorcelainV2(call: RecordedCommand): boolean {
  return call.args.includes("--porcelain=v2");
}

function isPorcelain(call: RecordedCommand): boolean {
  return call.args.includes("--porcelain") && !isPorcelainV2(call);
}

describe("runSync", () => {
  let tmp: string;
  const now = new Date("2026-05-22T12:00:00.000Z");

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "run-sync-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("runSync refuses with exit 2 when worktree is dirty", async () => {
    const runner = makeRunner((call) =>
      isPorcelain(call) ? { stdout: "M wiki/foo.md\n?? wiki/bar.md\n" } : { stdout: "0\t0\n" },
    );

    await expect(runSync({ memoryRoot: tmp, runner, now })).rejects.toMatchObject({ exitCode: 2 });
    await expect(runSync({ memoryRoot: tmp, runner, now })).rejects.toThrow(/wiki\/foo\.md[\s\S]*wiki\/bar\.md/);
  });

  it("runSync refuses with exit 3 when sync-state.json has conflicts_pending > 0", async () => {
    await writeSyncStateFile(tmp, {
      last_sync_attempt: null,
      last_sync_success: null,
      pending_push_count: 0,
      conflicts_pending: 2,
      conflict_files: ["wiki/x.md", "wiki/y.md"],
    });
    const runner = makeRunner((call) =>
      isPorcelain(call) ? { stdout: "" } : { stdout: "0\t0\n" },
    );

    await expect(runSync({ memoryRoot: tmp, runner, now })).rejects.toMatchObject({ exitCode: 3 });
    await expect(runSync({ memoryRoot: tmp, runner, now })).rejects.toThrow(/wiki\/x\.md[\s\S]*wiki\/y\.md/);
  });

  it("runSync is a no-op when clean and synced", async () => {
    const runner = makeRunner((call) =>
      isPorcelain(call) ? { stdout: "" } : isRevList(call) ? { stdout: "0\t0\n" } : { stdout: "" },
    );

    const result = await runSync({ memoryRoot: tmp, runner, now });
    const state = JSON.parse(await readFile(join(tmp, ".sync-state.json"), "utf-8"));

    expect(result.actionsPerformed).toEqual([]);
    expect(result.finalState).toBe("clean");
    expect(state.last_sync_success).toBe(now.toISOString());
  });

  it("runSync pushes when local-ahead", async () => {
    const runner = makeRunner((call) =>
      isPorcelain(call) ? { stdout: "" } : isRevList(call) ? { stdout: "2\t0\n" } : { stdout: "" },
    );

    const result = await runSync({ memoryRoot: tmp, runner, now });

    expect(runner.calls.map(commandLine)).toContain("git push vps main");
    expect(result.actionsPerformed).toEqual(["push"]);
    expect(result.finalState).toBe("clean");
  });

  it("runSync uses sync.remote_name from config when no remote option is passed", async () => {
    await writeFile(join(tmp, "config.yaml"), "sync:\n  remote_name: mirror\n");
    const runner = makeRunner((call) =>
      isPorcelain(call) ? { stdout: "" } : isRevList(call) ? { stdout: "2\t0\n" } : { stdout: "" },
    );

    const result = await runSync({ memoryRoot: tmp, runner, now });

    expect(runner.calls.map(commandLine)).toContain("git fetch mirror main");
    expect(runner.calls.map(commandLine)).toContain("git push mirror main");
    expect(result.actionsPerformed).toEqual(["push"]);
  });

  it("runSync explicit remote option overrides sync.remote_name from config", async () => {
    await writeFile(join(tmp, "config.yaml"), "sync:\n  remote_name: mirror\n");
    const runner = makeRunner((call) =>
      isPorcelain(call) ? { stdout: "" } : isRevList(call) ? { stdout: "2\t0\n" } : { stdout: "" },
    );

    await runSync({ memoryRoot: tmp, remoteName: "manual", runner, now });

    expect(runner.calls.map(commandLine)).toContain("git fetch manual main");
    expect(runner.calls.map(commandLine)).toContain("git push manual main");
    expect(runner.calls.map(commandLine)).not.toContain("git fetch mirror main");
  });

  it("runSync pull-rebases then pushes when divergent", async () => {
    const runner = makeRunner((call) =>
      isPorcelain(call) ? { stdout: "" } : isRevList(call) ? { stdout: "2\t3\n" } : { stdout: "" },
    );

    const result = await runSync({ memoryRoot: tmp, runner, now });

    expect(result.actionsPerformed).toEqual(["pull-rebase", "push"]);
    expect(runner.calls.map(commandLine)).toContain("git pull --rebase vps main");
    expect(runner.calls.map(commandLine)).toContain("git push vps main");
  });

  it("runSync on rebase conflict: aborts rebase, marks conflicted, writes errors.log, exits 3", async () => {
    const runner = makeRunner((call) => {
      if (isPorcelain(call)) return { stdout: "" };
      if (isRevList(call)) return { stdout: "2\t3\n" };
      if (commandLine(call) === "git pull --rebase vps main") {
        return { stderr: "conflict", exitCode: 1 };
      }
      if (isPorcelainV2(call)) {
        return {
          stdout: "u UU N... 100644 100644 100644 100644 a b c d wiki/projects/foo.md\nu UU N... 100644 100644 100644 100644 a b c d wiki/decisions/bar.md\n",
        };
      }
      return { stdout: "" };
    });

    await expect(runSync({ memoryRoot: tmp, runner, now })).rejects.toMatchObject({ exitCode: 3 });
    const state = JSON.parse(await readFile(join(tmp, ".sync-state.json"), "utf-8"));
    const errors = await readFile(join(tmp, "errors.log"), "utf-8");

    expect(runner.calls.map(commandLine)).toContain("git rebase --abort");
    expect(state.conflicts_pending).toBe(2);
    expect(state.conflict_files).toEqual(["wiki/projects/foo.md", "wiki/decisions/bar.md"]);
    expect(errors).toContain("sync conflict | 2 files | wiki/projects/foo.md, wiki/decisions/bar.md");
  });
});
