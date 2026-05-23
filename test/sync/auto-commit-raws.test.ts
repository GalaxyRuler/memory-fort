import { describe, expect, it } from "vitest";
import { autoCommitRawsIfDirty } from "../../src/sync/auto-commit-raws.js";
import type { CommandRunner } from "../../src/sync/git-remote.js";

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

describe("autoCommitRawsIfDirty", () => {
  it("returns no-dirty-files when git status is empty", async () => {
    const { runner, calls } = makeRunner(() => ({ stdout: "" }));

    await expect(autoCommitRawsIfDirty({ memoryRoot: "/mem", runner })).resolves.toEqual({
      kind: "no-dirty-files",
    });

    expect(calls.map((call) => call.args.join(" "))).toEqual(["status --porcelain"]);
  });

  it("commits when only raw/ is dirty", async () => {
    const { runner, calls } = makeRunner((call) => {
      const args = call.args.join(" ");
      if (args === "status --porcelain") {
        return { stdout: " M raw/2026-05-21/foo.md\n?? raw/2026-05-23/bar.md\n" };
      }
      if (args === "add raw/") return {};
      if (args.startsWith("commit -m")) {
        return { stdout: "[main abc1234] chore: auto-capture 2 raw observation file(s)\n" };
      }
      throw new Error(`unexpected command: ${args}`);
    });

    await expect(autoCommitRawsIfDirty({ memoryRoot: "/mem", runner })).resolves.toEqual({
      kind: "committed",
      filesCount: 2,
      commitSha: "abc1234",
    });

    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "status --porcelain",
      "add raw/",
      "commit -m chore: auto-capture 2 raw observation file(s)",
    ]);
  });

  it("skips when wiki/ is dirty", async () => {
    const { runner, calls } = makeRunner(() => ({
      stdout: " M wiki/projects/foo.md\n M raw/2026-05-21/foo.md\n",
    }));

    await expect(autoCommitRawsIfDirty({ memoryRoot: "/mem", runner })).resolves.toEqual({
      kind: "skipped-non-raw-dirty",
      dirtyNonRawFiles: ["wiki/projects/foo.md"],
    });

    expect(calls.map((call) => call.args.join(" "))).toEqual(["status --porcelain"]);
  });

  it("skips when crystals/ or top-level is dirty", async () => {
    const { runner, calls } = makeRunner(() => ({
      stdout: " M crystals/2026-05-22.md\n M index.md\n M raw/foo.md\n",
    }));

    await expect(autoCommitRawsIfDirty({ memoryRoot: "/mem", runner })).resolves.toEqual({
      kind: "skipped-non-raw-dirty",
      dirtyNonRawFiles: ["crystals/2026-05-22.md", "index.md"],
    });

    expect(calls.map((call) => call.args.join(" "))).toEqual(["status --porcelain"]);
  });
});
