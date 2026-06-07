import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGrep } from "../../../src/cli/commands/grep.js";

function hasRipgrep(): boolean {
  const result = spawnSync("rg", ["--version"], { encoding: "utf-8" });
  return !result.error && result.status === 0;
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

  it("includes both raw/ and wiki/ when scope=both by default", () => {
    let capturedArgs: string[] = [];
    const result = runGrep({
      pattern: "foo",
      spawn: (_cmd, args) => {
        capturedArgs = args;
        return { status: 0, stdout: "", stderr: "", pid: 0, output: [], signal: null } as never;
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.dirsSearched.some((dir) => dir.includes("raw"))).toBe(true);
    expect(result.dirsSearched.some((dir) => dir.includes("wiki"))).toBe(true);
    expect(capturedArgs).toContain("foo");
  });

  it("sets a 64 MiB maxBuffer for ripgrep output", () => {
    let capturedOptions: { encoding: "utf-8"; maxBuffer?: number } | undefined;
    const result = runGrep({
      pattern: "foo",
      spawn: (_cmd, _args, opts) => {
        capturedOptions = opts;
        return { status: 0, stdout: "", stderr: "", pid: 0, output: [], signal: null } as never;
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(capturedOptions).toEqual({ encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  });

  it("restricts to raw/ only when scope=raw", () => {
    const result = runGrep({
      pattern: "x",
      scope: "raw",
      spawn: () =>
        ({ status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null }) as never,
      stdout: () => {},
      stderr: () => {},
    });
    expect(result.dirsSearched.every((dir) => dir.includes("raw"))).toBe(true);
    expect(result.dirsSearched.some((dir) => dir.includes("wiki"))).toBe(false);
  });

  it("restricts to wiki/ only when scope=wiki", () => {
    const result = runGrep({
      pattern: "x",
      scope: "wiki",
      spawn: () =>
        ({ status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null }) as never,
      stdout: () => {},
      stderr: () => {},
    });
    expect(result.dirsSearched.every((dir) => dir.includes("wiki"))).toBe(true);
    expect(result.dirsSearched.some((dir) => dir.includes("raw"))).toBe(false);
  });

  it("returns exit 1 when rg reports no matches", () => {
    let stderrCapture = "";
    const result = runGrep({
      pattern: "nonexistent",
      spawn: () =>
        ({ status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null }) as never,
      stdout: () => {},
      stderr: (text) => {
        stderrCapture += text;
      },
    });
    expect(result.exitCode).toBe(1);
    expect(stderrCapture).toBe('No matches for "nonexistent" in raw/ + wiki/.\n');
  });

  it("prints raw/ for no matches when scope=raw", () => {
    let stderrCapture = "";
    const result = runGrep({
      pattern: "nonexistent",
      scope: "raw",
      spawn: () =>
        ({ status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null }) as never,
      stdout: () => {},
      stderr: (text) => {
        stderrCapture += text;
      },
    });
    expect(result.exitCode).toBe(1);
    expect(stderrCapture).toBe('No matches for "nonexistent" in raw/.\n');
  });

  it("prints wiki/ for no matches when scope=wiki", () => {
    let stderrCapture = "";
    const result = runGrep({
      pattern: "nonexistent",
      scope: "wiki",
      spawn: () =>
        ({ status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null }) as never,
      stdout: () => {},
      stderr: (text) => {
        stderrCapture += text;
      },
    });
    expect(result.exitCode).toBe(1);
    expect(stderrCapture).toBe('No matches for "nonexistent" in wiki/.\n');
  });

  it("escapes quotes and newlines in the no-match pattern", () => {
    let stderrCapture = "";
    const result = runGrep({
      pattern: 'quoted "pattern"\nnext line',
      spawn: () =>
        ({ status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null }) as never,
      stdout: () => {},
      stderr: (text) => {
        stderrCapture += text;
      },
    });
    expect(result.exitCode).toBe(1);
    expect(stderrCapture).toBe(
      'No matches for "quoted \\"pattern\\"\\nnext line" in raw/ + wiki/.\n',
    );
  });

  it("does not print the no-match message when rg reports stderr", () => {
    let stderrCapture = "";
    const result = runGrep({
      pattern: "nonexistent",
      spawn: () =>
        ({
          status: 1,
          stdout: "",
          stderr: "rg: raw: Permission denied\n",
          pid: 0,
          output: [],
          signal: null,
        }) as never,
      stdout: () => {},
      stderr: (text) => {
        stderrCapture += text;
      },
    });
    expect(result.exitCode).toBe(1);
    expect(stderrCapture).toBe("rg: raw: Permission denied\n");
  });

  it("does not print the no-match message when rg reports an error status", () => {
    let stderrCapture = "";
    const result = runGrep({
      pattern: "nonexistent",
      spawn: () =>
        ({ status: 2, stdout: "", stderr: "", pid: 0, output: [], signal: null }) as never,
      stdout: () => {},
      stderr: (text) => {
        stderrCapture += text;
      },
    });
    expect(result.exitCode).toBe(2);
    expect(stderrCapture).toBe("");
  });

  it("returns exit 2 when rg is not found", () => {
    const result = runGrep({
      pattern: "x",
      spawn: () => {
        const err = new Error("spawn rg ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        return {
          status: null,
          stdout: "",
          stderr: "",
          pid: 0,
          output: [],
          signal: null,
          error: err,
        } as never;
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(result.exitCode).toBe(2);
  });

  it("returns exit 2 with a clear message when ripgrep output exceeds maxBuffer", () => {
    let stderrCapture = "";
    const result = runGrep({
      pattern: "x",
      spawn: () => {
        const err = new Error("spawnSync rg ENOBUFS") as NodeJS.ErrnoException;
        err.code = "ENOBUFS";
        return {
          status: null,
          stdout: "",
          stderr: "",
          pid: 0,
          output: [],
          signal: null,
          error: err,
        } as never;
      },
      stdout: () => {},
      stderr: (text) => {
        stderrCapture += text;
      },
    });
    expect(result.exitCode).toBe(2);
    expect(stderrCapture).toBe(
      "memory grep: ripgrep output exceeded 64 MiB; narrow the pattern or scope and retry.\n",
    );
  });

  it("returns exit 2 when both raw/ and wiki/ are absent", async () => {
    const empty = await mkdtemp(join(tmpdir(), "empty-mem-"));
    process.env["MEMORY_ROOT"] = empty;
    try {
      const result = runGrep({
        pattern: "x",
        spawn: () =>
          ({ status: 0, stdout: "", stderr: "", pid: 0, output: [], signal: null }) as never,
        stdout: () => {},
        stderr: () => {},
      });
      expect(result.exitCode).toBe(2);
      expect(result.dirsSearched).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
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

  realRgIt("finds matches with real ripgrep", () => {
    let stdoutCapture = "";
    const result = runGrep({
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
