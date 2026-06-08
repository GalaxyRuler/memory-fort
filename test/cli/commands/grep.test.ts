import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runGrep, type GrepChildProcess } from "../../../src/cli/commands/grep.js";

function hasRipgrep(): boolean {
  const result = spawnSync("rg", ["--version"], { encoding: "utf-8" });
  return !result.error && result.status === 0;
}

function mockRgResult(opts: {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: NodeJS.ErrnoException;
}): GrepChildProcess {
  const child = new EventEmitter() as GrepChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  };

  queueMicrotask(() => {
    if (opts.error) {
      child.emit("error", opts.error);
      return;
    }
    child.stdout.end(opts.stdout ?? "");
    child.stderr.end(opts.stderr ?? "");
    child.emit("close", opts.status ?? 0, null);
  });

  return child;
}

describe("runGrep (mocked spawn)", () => {
  let tmp: string;
  let origMem: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "grep-"));
    origMem = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
    await mkdir(join(tmp, "raw", "2026-05-21"), { recursive: true });
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    await rm(tmp, { recursive: true, force: true });
  });

  it("includes both raw/ and wiki/ when scope=both by default", async () => {
    let capturedArgs: string[] = [];
    const result = await runGrep({
      pattern: "foo",
      spawn: (_cmd, args) => {
        capturedArgs = args;
        return mockRgResult({ status: 0 });
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.dirsSearched.some((dir) => dir.includes("raw"))).toBe(true);
    expect(result.dirsSearched.some((dir) => dir.includes("wiki"))).toBe(true);
    expect(capturedArgs).toContain("foo");
  });

  it("restricts to raw/ only when scope=raw", async () => {
    const result = await runGrep({
      pattern: "x",
      scope: "raw",
      spawn: () => mockRgResult({ status: 1 }),
      stdout: () => {},
      stderr: () => {},
    });
    expect(result.dirsSearched.every((dir) => dir.includes("raw"))).toBe(true);
    expect(result.dirsSearched.some((dir) => dir.includes("wiki"))).toBe(false);
  });

  it("restricts to wiki/ only when scope=wiki", async () => {
    const result = await runGrep({
      pattern: "x",
      scope: "wiki",
      spawn: () => mockRgResult({ status: 1 }),
      stdout: () => {},
      stderr: () => {},
    });
    expect(result.dirsSearched.every((dir) => dir.includes("wiki"))).toBe(true);
    expect(result.dirsSearched.some((dir) => dir.includes("raw"))).toBe(false);
  });

  it("returns exit 1 when rg reports no matches", async () => {
    const result = await runGrep({
      pattern: "nonexistent",
      spawn: () => mockRgResult({ status: 1 }),
      stdout: () => {},
      stderr: () => {},
    });
    expect(result.exitCode).toBe(1);
  });

  it("returns exit 2 when rg is not found", async () => {
    const result = await runGrep({
      pattern: "x",
      spawn: () => {
        const err = new Error("spawn rg ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        return mockRgResult({ error: err });
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(result.exitCode).toBe(2);
  });

  it("returns exit 2 when both raw/ and wiki/ are absent", async () => {
    const empty = await mkdtemp(join(tmpdir(), "empty-mem-"));
    process.env["MEMORY_ROOT"] = empty;
    try {
      const result = await runGrep({
        pattern: "x",
        spawn: () => mockRgResult({ status: 0 }),
        stdout: () => {},
        stderr: () => {},
      });
      expect(result.exitCode).toBe(2);
      expect(result.dirsSearched).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("writes large result sets incrementally and caps output at the default limit", async () => {
    const rgOutput = Array.from(
      { length: 600 },
      (_, index) => `${join(tmp, "wiki", "projects", `hit-${index}.md`)}:1:foo ${index}`,
    ).join("\n") + "\n";
    const writes: string[] = [];

    const result = await runGrep({
      pattern: "foo",
      spawn: () => mockRgResult({ status: 0, stdout: rgOutput }),
      stdout: (text) => {
        writes.push(text);
      },
      stderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(501);
    expect(writes.slice(0, 500).every((write) => write.endsWith("\n"))).toBe(true);
    expect(writes.at(-1)).toBe("# truncated at 500 results\n");
    expect(Math.max(...writes.map((write) => Buffer.byteLength(write, "utf-8")))).toBeLessThan(64 * 1024);
  });
});

describe("runGrep (real rg integration)", () => {
  const realRgIt = hasRipgrep() ? it : it.skip;
  let tmp: string;
  let origMem: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "grep-real-"));
    origMem = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "agentmemory.md"),
      "---\ntype: projects\ntitle: agentmemory\n---\n\nThe Windows stale port issue was fixed.\n",
    );
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    await rm(tmp, { recursive: true, force: true });
  });

  realRgIt("finds matches with real ripgrep", async () => {
    let stdoutCapture = "";
    const result = await runGrep({
      pattern: "stale port",
      scope: "wiki",
      stdout: (text) => {
        stdoutCapture += text;
      },
      stderr: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(stdoutCapture).toContain("agentmemory.md");
    expect(stdoutCapture).toContain("stale port");
  });
});
