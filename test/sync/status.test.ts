import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSyncStateFile,
  getSyncStatus,
  readSyncStateFile,
  writeSyncStateFile,
  type StatusContext,
} from "../../src/sync/status.js";
import type { CommandRunner } from "../../src/sync/git-remote.js";

interface RecordedCommand {
  cmd: string;
  args: string[];
  opts?: { cwd?: string; stdin?: string };
}

function makeRunner(
  handler: (call: RecordedCommand) => { stdout?: string; stderr?: string; exitCode?: number },
): CommandRunner {
  return {
    async run(cmd: string, args: string[], opts?: { cwd?: string; stdin?: string }) {
      const result = handler({ cmd, args, opts });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
  };
}

describe("getSyncStatus", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sync-status-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function ctx(runner: CommandRunner): StatusContext {
    return { memoryRoot: tmp, remoteName: "vps", branch: "main", runner };
  }

  it("getSyncStatus returns clean when local equals remote and tree is clean", async () => {
    const runner = makeRunner((call) =>
      call.args.includes("--porcelain") ? { stdout: "" } : { stdout: "0\t0\n" },
    );

    const status = await getSyncStatus(ctx(runner));

    expect(status.state).toBe("clean");
    expect(status.localAhead).toBe(0);
    expect(status.remoteAhead).toBe(0);
  });

  it("getSyncStatus returns dirty when working tree has uncommitted changes", async () => {
    const runner = makeRunner((call) =>
      call.args.includes("--porcelain")
        ? { stdout: "M wiki/foo.md\n?? wiki/bar.md\n" }
        : { stdout: "0\t0\n" },
    );

    const status = await getSyncStatus(ctx(runner));

    expect(status.state).toBe("dirty");
    expect(status.dirtyFiles).toEqual(["wiki/foo.md", "wiki/bar.md"]);
  });

  it("getSyncStatus returns local-ahead when local has commits remote doesn't", async () => {
    const runner = makeRunner((call) =>
      call.args.includes("--porcelain") ? { stdout: "" } : { stdout: "2\t0\n" },
    );

    const status = await getSyncStatus(ctx(runner));

    expect(status.state).toBe("local-ahead");
    expect(status.localAhead).toBe(2);
    expect(status.remoteAhead).toBe(0);
  });

  it("getSyncStatus returns remote-ahead when remote has commits local doesn't", async () => {
    const runner = makeRunner((call) =>
      call.args.includes("--porcelain") ? { stdout: "" } : { stdout: "0\t3\n" },
    );

    const status = await getSyncStatus(ctx(runner));

    expect(status.state).toBe("remote-ahead");
    expect(status.localAhead).toBe(0);
    expect(status.remoteAhead).toBe(3);
  });

  it("getSyncStatus returns divergent when both have new commits", async () => {
    const runner = makeRunner((call) =>
      call.args.includes("--porcelain") ? { stdout: "" } : { stdout: "2\t3\n" },
    );

    const status = await getSyncStatus(ctx(runner));

    expect(status.state).toBe("divergent");
    expect(status.localAhead).toBe(2);
    expect(status.remoteAhead).toBe(3);
  });

  it("getSyncStatus returns conflicted when sync-state.json shows conflicts_pending > 0", async () => {
    await writeSyncStateFile(tmp, {
      last_sync_attempt: null,
      last_sync_success: null,
      pending_push_count: 0,
      conflicts_pending: 2,
      conflict_files: ["x.md", "y.md"],
    });
    const runner = makeRunner((call) =>
      call.args.includes("--porcelain") ? { stdout: "" } : { stdout: "0\t0\n" },
    );

    const status = await getSyncStatus(ctx(runner));

    expect(status.state).toBe("conflicted");
    expect(status.syncStateFile.conflict_files).toEqual(["x.md", "y.md"]);
  });

  it("readSyncStateFile tolerates corrupt JSON", async () => {
    await writeFile(join(tmp, ".sync-state.json"), "{invalid", "utf-8");

    await expect(readSyncStateFile(tmp)).resolves.toEqual(await defaultSyncStateFile());
  });
});
