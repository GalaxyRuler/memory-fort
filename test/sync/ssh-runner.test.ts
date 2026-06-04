import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { makeRealSshRunner } from "../../src/sync/ssh-runner.js";
import { spawn } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

function mockProcess(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe("makeRealSshRunner", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it("makeRealSshRunner spawns ssh with host and command", async () => {
    const proc = mockProcess();
    vi.mocked(spawn).mockReturnValue(proc as never);

    const promise = makeRealSshRunner().run("examplehost", {
      command: "echo hello",
      description: "test",
    });
    proc.stdout.emit("data", Buffer.from("hello"));
    proc.emit("close", 0);

    await expect(promise).resolves.toEqual({
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    });
    expect(spawn).toHaveBeenCalledWith("ssh", ["examplehost", "echo hello"], {
      windowsHide: true,
    });
  });

  it("makeRealSshRunner rejects on spawn failure", async () => {
    const proc = mockProcess();
    vi.mocked(spawn).mockReturnValue(proc as never);

    const promise = makeRealSshRunner().run("examplehost", {
      command: "echo hello",
      description: "test",
    });
    proc.emit("error", new Error("connection refused"));

    await expect(promise).rejects.toThrow(/ssh.*connection refused/);
  });
});
