import { describe, it, expect } from "vitest";
import {
  addRemote,
  pushToRemote,
  remoteHasCommits,
  type CommandRunner,
} from "../../src/sync/git-remote.js";

interface RecordedCommand {
  cmd: string;
  args: string[];
  opts?: { cwd?: string; stdin?: string };
}

function makeRunner(
  handler: (call: RecordedCommand, index: number) => {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  },
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

function argString(call: RecordedCommand): string {
  return [call.cmd, ...call.args].join(" ");
}

describe("git remote helpers", () => {
  it("addRemote creates a new remote when none exists", async () => {
    const runner = makeRunner((call) =>
      call.args.includes("get-url")
        ? { stderr: "No such remote", exitCode: 2 }
        : { stdout: "" },
    );

    const result = await addRemote("/repo", "vps", "root@host:/repo.git", runner);

    expect(result).toEqual({ created: true, previousUrl: null });
    expect(runner.calls.some((call) => argString(call) === "git remote add vps root@host:/repo.git")).toBe(true);
  });

  it("addRemote updates a remote with a different URL via set-url", async () => {
    const runner = makeRunner((call) =>
      call.args.includes("get-url") ? { stdout: "old-url\n" } : { stdout: "" },
    );

    const result = await addRemote("/repo", "vps", "new-url", runner);

    expect(result).toEqual({ created: false, previousUrl: "old-url" });
    expect(runner.calls.some((call) => argString(call) === "git remote set-url vps new-url")).toBe(true);
  });

  it("addRemote is no-op when URL already matches", async () => {
    const runner = makeRunner(() => ({ stdout: "same-url\n" }));

    const result = await addRemote("/repo", "vps", "same-url", runner);

    expect(result).toEqual({ created: false, previousUrl: "same-url" });
    expect(runner.calls.some((call) => call.args.includes("add"))).toBe(false);
    expect(runner.calls.some((call) => call.args.includes("set-url"))).toBe(false);
  });

  it("pushToRemote succeeds and returns the output", async () => {
    const runner = makeRunner(() => ({ stdout: "pushed\n" }));

    const result = await pushToRemote("/repo", "vps", "main", runner);

    expect(result).toEqual({ pushed: true, output: "pushed\n" });
  });

  it("remoteHasCommits returns true when ref exists", async () => {
    const runner = makeRunner((_call, index) =>
      index === 0 ? { stdout: "abc123\trefs/heads/main\n" } : { stdout: "" },
    );

    await expect(remoteHasCommits("/repo", "vps", "main", runner)).resolves.toBe(true);
    await expect(remoteHasCommits("/repo", "vps", "main", runner)).resolves.toBe(false);
  });
});
