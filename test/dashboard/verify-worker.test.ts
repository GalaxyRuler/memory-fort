import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runVerifyInChild } from "../../src/dashboard/verify-worker.js";

// /api/health runs `memory verify`, which loads the embeddings sidecars + corpus
// and peaks into the GBs. Run that in a child process so the heavy load stays
// off the dashboard/app heap; the child prints its VerifyResult as JSON and the
// parent parses it. verify exits non-zero when checks fail but still emits a
// valid report, so the report is parsed regardless of exit code.
describe("runVerifyInChild", () => {
  function fakeSpawn(report: unknown, exitCode: number) {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
    child.stdout = new EventEmitter();
    const spawnFn = vi.fn((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify(report)));
        child.emit("exit", exitCode);
      });
      return child;
    });
    return { spawnFn, calls };
  }

  it("spawns the verify worker with vaultRoot/role/deep and parses its JSON report", async () => {
    const report = { overallStatus: "pass", passed: 3, failed: 0, warnings: 1, checks: [], role: "operator", startedAt: "", finishedAt: "", exitCode: 0 };
    const { spawnFn, calls } = fakeSpawn(report, 0);
    const result = await runVerifyInChild(
      { vaultRoot: "/vault", role: "operator", includeSearch: false },
      { spawnFn: spawnFn as never, workerPath: "/w/verify-worker.mjs" },
    );
    expect(result.overallStatus).toBe("pass");
    expect(result.passed).toBe(3);
    expect(calls[0].cmd).toBe("node");
    expect(calls[0].args.slice(-4)).toEqual(["/w/verify-worker.mjs", "/vault", "operator", "0"]);
  });

  it("still resolves the report when verify exits non-zero (checks failed)", async () => {
    const report = { overallStatus: "fail", passed: 1, failed: 2, warnings: 0, checks: [], role: "server", startedAt: "", finishedAt: "", exitCode: 1 };
    const { spawnFn, calls } = fakeSpawn(report, 1);
    const result = await runVerifyInChild(
      { vaultRoot: "/vault", role: "server", includeSearch: true },
      { spawnFn: spawnFn as never, workerPath: "/w/verify-worker.mjs" },
    );
    expect(result.overallStatus).toBe("fail");
    expect(result.failed).toBe(2);
    expect(calls[0].args.slice(-4)).toEqual(["/w/verify-worker.mjs", "/vault", "server", "1"]);
  });
});
