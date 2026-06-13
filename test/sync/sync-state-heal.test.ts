import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../../src/sync/git-remote.js";
import {
  getSyncStatus,
  mutateSyncStateFile,
  readSyncStateFile,
  writeSyncStateFile,
} from "../../src/sync/status.js";

function fakeRunner(responses: Record<string, { stdout: string; exitCode: number }>): CommandRunner {
  return {
    async run(_cmd, args) {
      const key = args.join(" ");
      const match = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
      if (!match) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: match[1].stdout, stderr: "", exitCode: match[1].exitCode };
    },
  };
}

describe("sync state", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sync-state-heal-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("mutateSyncStateFile merges concurrent patches without losing fields", async () => {
    await Promise.all([
      mutateSyncStateFile(root, (s) => ({ ...s, pending_push_count: 3 })),
      mutateSyncStateFile(root, (s) => ({ ...s, last_sync_success: "2026-06-12T00:00:00Z" })),
    ]);
    const state = await readSyncStateFile(root);
    expect(state.pending_push_count).toBe(3);
    expect(state.last_sync_success).toBe("2026-06-12T00:00:00Z");
  });

  it("getSyncStatus clears a recorded conflict when git has no unmerged paths", async () => {
    await writeSyncStateFile(root, {
      last_sync_attempt: "2026-06-10T00:00:00Z",
      last_sync_success: null,
      pending_push_count: 0,
      conflicts_pending: 2,
      conflict_files: ["raw/a.md", "raw/b.md"],
    });
    const runner = fakeRunner({
      "ls-files -u": { stdout: "", exitCode: 0 },
      "status --porcelain": { stdout: "", exitCode: 0 },
      "rev-list": { stdout: "0\t0\n", exitCode: 0 },
    });
    const status = await getSyncStatus({ memoryRoot: root, remoteName: "origin", branch: "main", runner });
    expect(status.state).toBe("clean");
    const persisted = await readSyncStateFile(root);
    expect(persisted.conflicts_pending).toBe(0);
    expect(persisted.conflict_files).toEqual([]);
  });

  it("getSyncStatus keeps reporting conflicted while unmerged paths exist", async () => {
    await writeSyncStateFile(root, {
      last_sync_attempt: "2026-06-10T00:00:00Z",
      last_sync_success: null,
      pending_push_count: 0,
      conflicts_pending: 1,
      conflict_files: ["raw/a.md"],
    });
    const runner = fakeRunner({
      "ls-files -u": { stdout: "100644 abc 1\traw/a.md\n", exitCode: 0 },
    });
    const status = await getSyncStatus({ memoryRoot: root, remoteName: "origin", branch: "main", runner });
    expect(status.state).toBe("conflicted");
  });
});
