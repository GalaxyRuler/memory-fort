import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runScheduledVaultTaskInChild } from "../../src/dashboard/auto-promote-scheduler.js";
import { runAutoHealTickInChild } from "../../src/dashboard/auto-heal-scheduler.js";

// Scheduled compile/auto-promote process the entire raw/ corpus; running them in
// the dashboard's own (Electron main) process spiked memory into the GBs and
// OOM-killed the app. They must run in a spawned child process so the heavy
// allocation lives and dies in the child, never the app.
describe("runScheduledVaultTaskInChild", () => {
  function fakeSpawn(exitCode: number) {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const child = new EventEmitter() as EventEmitter & { unref?: () => void };
    child.unref = () => undefined;
    const spawnFn = vi.fn((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      queueMicrotask(() => child.emit("exit", exitCode));
      return child;
    });
    return { spawnFn, calls };
  }

  it("spawns the worker with the vault root and task kind, resolving on exit 0", async () => {
    const { spawnFn, calls } = fakeSpawn(0);
    await runScheduledVaultTaskInChild("/vault", "compile", {
      spawnFn: spawnFn as never,
      workerPath: "/w/scheduled-vault-worker.mjs",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("node");
    expect(calls[0].args).toEqual(["/w/scheduled-vault-worker.mjs", "/vault", "compile"]);
  });

  it("rejects when the worker exits non-zero", async () => {
    const { spawnFn } = fakeSpawn(1);
    await expect(
      runScheduledVaultTaskInChild("/vault", "vault", {
        spawnFn: spawnFn as never,
        workerPath: "/w/scheduled-vault-worker.mjs",
      }),
    ).rejects.toThrow(/exited with code 1/);
  });

  it("isolates the auto-heal tick in a child, passing the reconcile flag", async () => {
    const { spawnFn, calls } = fakeSpawn(0);
    await runAutoHealTickInChild("/vault", true, {
      spawnFn: spawnFn as never,
      workerPath: "/w/scheduled-vault-worker.mjs",
    });
    expect(calls[0].args).toEqual(["/w/scheduled-vault-worker.mjs", "/vault", "auto-heal", "1"]);
  });

  it("passes reconcile=0 and rejects on a failed auto-heal worker", async () => {
    const { spawnFn } = fakeSpawn(1);
    await expect(
      runAutoHealTickInChild("/vault", false, {
        spawnFn: spawnFn as never,
        workerPath: "/w/scheduled-vault-worker.mjs",
      }),
    ).rejects.toThrow(/exited with code 1/);
  });
});
