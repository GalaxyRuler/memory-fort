import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAutoPushWorker } from "../../src/sync/auto-push-worker.js";
import { writePendingFile } from "../../src/sync/auto-push.js";
import { readSyncStateFile } from "../../src/sync/status.js";

describe("runAutoPushWorker", () => {
  let tmp: string;
  const now = () => new Date("2026-05-23T00:00:00.000Z");
  const sleepFn = async () => {};

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "auto-push-worker-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("Stale token outcome", async () => {
    let syncCalls = 0;
    await writePendingFile(tmp, {
      token: "A",
      scheduledAt: now().toISOString(),
      debounceMs: 5000,
    });

    const result = await runAutoPushWorker({
      memoryRoot: tmp,
      myToken: "B",
      sleepFn,
      syncFn: async () => {
        syncCalls++;
        throw new Error("should not sync");
      },
      now,
    });

    expect(result).toEqual({ outcome: "stale-token" });
    expect(syncCalls).toBe(0);
  });

  it("No pending file outcome", async () => {
    let syncCalls = 0;

    const result = await runAutoPushWorker({
      memoryRoot: tmp,
      myToken: "A",
      sleepFn,
      syncFn: async () => {
        syncCalls++;
        throw new Error("should not sync");
      },
      now,
    });

    expect(result).toEqual({ outcome: "no-pending-file" });
    expect(syncCalls).toBe(0);
  });

  it("Successful push", async () => {
    await writePendingFile(tmp, {
      token: "A",
      scheduledAt: now().toISOString(),
      debounceMs: 5000,
    });

    const result = await runAutoPushWorker({
      memoryRoot: tmp,
      myToken: "A",
      sleepFn,
      syncFn: async () => ({
        initialState: "local-ahead",
        finalState: "clean",
        actionsPerformed: ["push"],
        retried: false,
        conflictFiles: [],
      }),
      now,
    });
    const state = await readSyncStateFile(tmp);

    expect(result).toEqual({ outcome: "pushed", details: "1 commits" });
    expect(existsSync(join(tmp, ".auto-push-pending"))).toBe(false);
    expect(state.last_sync_success).toBe(now().toISOString());
  });

  it("Offline failure", async () => {
    await writePendingFile(tmp, {
      token: "A",
      scheduledAt: now().toISOString(),
      debounceMs: 5000,
    });

    const result = await runAutoPushWorker({
      memoryRoot: tmp,
      myToken: "A",
      sleepFn,
      syncFn: async () => {
        throw new Error("network unreachable");
      },
      now,
    });
    const state = await readSyncStateFile(tmp);
    const log = await readFile(join(tmp, "auto-sync.log"), "utf-8");

    expect(result.outcome).toBe("offline");
    expect(existsSync(join(tmp, ".auto-push-pending"))).toBe(false);
    expect(state.pending_push_count).toBeGreaterThan(0);
    expect(log).toContain("auto-push failed | network unreachable");
  });

  it("Conflict outcome", async () => {
    await writePendingFile(tmp, {
      token: "A",
      scheduledAt: now().toISOString(),
      debounceMs: 5000,
    });

    const result = await runAutoPushWorker({
      memoryRoot: tmp,
      myToken: "A",
      sleepFn,
      syncFn: async () => ({
        initialState: "divergent",
        finalState: "conflicted",
        actionsPerformed: ["pull-rebase"],
        retried: false,
        conflictFiles: ["wiki/foo.md", "wiki/bar.md"],
      }),
      now,
    });
    const state = await readSyncStateFile(tmp);
    const errors = await readFile(join(tmp, "errors.log"), "utf-8");

    expect(result.outcome).toBe("conflict");
    expect(existsSync(join(tmp, ".auto-push-pending"))).toBe(false);
    expect(state.conflicts_pending).toBe(2);
    expect(errors).toContain("auto-push conflict | 2 files | wiki/foo.md, wiki/bar.md");
  });

  it("Worker calls autoCommitRawsIfDirty before runSync", async () => {
    await writePendingFile(tmp, {
      token: "A",
      scheduledAt: now().toISOString(),
      debounceMs: 5000,
    });
    const events: string[] = [];
    const logs: string[] = [];

    const result = await runAutoPushWorker({
      memoryRoot: tmp,
      myToken: "A",
      sleepFn,
      autoCommitFn: async () => {
        events.push("auto-commit");
        return { kind: "committed", filesCount: 3, commitSha: "abc1234ffff" };
      },
      syncFn: async () => {
        events.push("sync");
        return {
          initialState: "local-ahead",
          finalState: "clean",
          actionsPerformed: ["push"],
          retried: false,
          conflictFiles: [],
        };
      },
      logSink: async (line) => {
        logs.push(line);
      },
      now,
    });

    expect(result).toEqual({ outcome: "pushed", details: "1 commits" });
    expect(events).toEqual(["auto-commit", "sync"]);
    expect(logs.some((line) => line.includes("auto-committed 3 raw observation file(s) as abc1234"))).toBe(true);
  });

  it("Worker skips push when non-raw files are dirty", async () => {
    await writePendingFile(tmp, {
      token: "A",
      scheduledAt: now().toISOString(),
      debounceMs: 5000,
    });
    let syncCalls = 0;
    const logs: string[] = [];

    const result = await runAutoPushWorker({
      memoryRoot: tmp,
      myToken: "A",
      sleepFn,
      autoCommitFn: async () => ({
        kind: "skipped-non-raw-dirty",
        dirtyNonRawFiles: ["wiki/projects/foo.md"],
      }),
      syncFn: async () => {
        syncCalls += 1;
        throw new Error("should not sync");
      },
      logSink: async (line) => {
        logs.push(line);
      },
      now,
    });

    expect(result).toEqual({ outcome: "offline", details: "non-raw dirty tree" });
    expect(syncCalls).toBe(0);
    expect(logs.some((line) => line.includes("auto-push skipped: non-raw dirty files present"))).toBe(true);
    expect(logs.some((line) => line.includes("wiki/projects/foo.md"))).toBe(true);
  });

  it("Worker skips push when dirty raw files contain secret-shaped content", async () => {
    await writePendingFile(tmp, {
      token: "A",
      scheduledAt: now().toISOString(),
      debounceMs: 5000,
    });
    let syncCalls = 0;
    const logs: string[] = [];

    const result = await runAutoPushWorker({
      memoryRoot: tmp,
      myToken: "A",
      sleepFn,
      autoCommitFn: async () => ({
        kind: "skipped-secret-raw-dirty",
        secretRawFiles: ["raw/2026-06-03/codex-secret.md"],
      }),
      syncFn: async () => {
        syncCalls += 1;
        throw new Error("should not sync");
      },
      logSink: async (line) => {
        logs.push(line);
      },
      now,
    });

    expect(result).toEqual({ outcome: "offline", details: "secret-shaped raw observations" });
    expect(syncCalls).toBe(0);
    expect(logs.some((line) => line.includes("auto-push skipped: secret-shaped raw observations"))).toBe(true);
    expect(logs.some((line) => line.includes("raw/2026-06-03/codex-secret.md"))).toBe(true);
  });
});
