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
});
