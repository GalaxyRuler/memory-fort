import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGrep } from "../../../src/cli/commands/grep.js";

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
    const result = runGrep({
      pattern: "nonexistent",
      spawn: () =>
        ({ status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null }) as never,
      stdout: () => {},
      stderr: () => {},
    });
    expect(result.exitCode).toBe(1);
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

  it("finds matches with real ripgrep", () => {
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
