import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { runCompile } from "../../../src/cli/commands/compile.js";

const CLI = resolve(process.cwd(), "dist", "cli.mjs");

const TEMPLATE = [
  "SCHEMA={{schema_content}}",
  "INDEX={{index_content}}",
  "LOG={{recent_log_lines}}",
  "FILES={{raw_files_list}}",
  "RAW={{raw_content}}",
].join("\n");

describe("runCompile", () => {
  let tmp: string;
  let root: string;
  let origMemRoot: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compile-"));
    root = join(tmp, ".memory");
    origMemRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = root;
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "raw", "2026-05-21"), { recursive: true });
    await mkdir(join(root, "wiki", "projects"), { recursive: true });
    await writeFile(join(root, "prompts", "compile.md"), TEMPLATE);
    await writeFile(join(root, "schema.md"), "# Schema\n");
    await writeFile(join(root, "index.md"), "# Index\n");
    await writeFile(join(root, "log.md"), "# Log\n");
  });

  afterEach(async () => {
    if (origMemRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMemRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  it("substitutes memory context and raw files into the prompt", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    await writeFile(rawPath, "raw observation alpha");

    const result = await runCompile();

    expect(result.sinceCutoff).toBe(new Date(0).toISOString());
    expect(result.rawFilesIncluded).toEqual([rawPath]);
    expect(result.rawFilesSkipped).toEqual([]);
    expect(result.truncatedAtTotalCap).toBe(false);
    expect(result.prompt).toContain("SCHEMA=# Schema");
    expect(result.prompt).toContain("INDEX=# Index");
    expect(result.prompt).toContain(rawPath);
    expect(result.prompt).toContain("raw observation alpha");
    expect(result.prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it("auto-detects since cutoff from the latest compile log line", async () => {
    await writeFile(
      join(root, "log.md"),
      [
        "# Log",
        "## [2026-05-20 10:00:00] compile | old",
        "## [2026-05-21 12:30:00] compile | latest",
      ].join("\n"),
    );
    const oldRaw = join(root, "raw", "2026-05-21", "manual-old.md");
    const newRaw = join(root, "raw", "2026-05-21", "manual-new.md");
    await writeFile(oldRaw, "old raw");
    await writeFile(newRaw, "new raw");
    await utimes(
      oldRaw,
      new Date("2026-05-21T12:00:00.000Z"),
      new Date("2026-05-21T12:00:00.000Z"),
    );
    await utimes(
      newRaw,
      new Date("2026-05-21T13:00:00.000Z"),
      new Date("2026-05-21T13:00:00.000Z"),
    );

    const result = await runCompile();

    expect(result.sinceCutoff).toBe("2026-05-21T12:30:00.000Z");
    expect(result.rawFilesIncluded).toEqual([newRaw]);
    expect(result.rawFilesSkipped).toEqual([
      { path: oldRaw, reason: "before since cutoff" },
    ]);
    expect(result.prompt).toContain("new raw");
    expect(result.prompt).not.toContain("old raw");
  });

  it("honors explicit since over log auto-detection", async () => {
    await writeFile(
      join(root, "log.md"),
      "## [2026-05-21 23:00:00] compile | later than explicit\n",
    );
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    await writeFile(rawPath, "included by explicit since");
    await utimes(
      rawPath,
      new Date("2026-05-21T13:00:00.000Z"),
      new Date("2026-05-21T13:00:00.000Z"),
    );

    const result = await runCompile({ since: "2026-05-21T12:00:00.000Z" });

    expect(result.sinceCutoff).toBe("2026-05-21T12:00:00.000Z");
    expect(result.rawFilesIncluded).toEqual([rawPath]);
  });

  it("applies per-file and total raw content caps", async () => {
    const first = join(root, "raw", "2026-05-21", "manual-a.md");
    const second = join(root, "raw", "2026-05-21", "manual-b.md");
    await writeFile(first, "abcdefghij");
    await writeFile(second, "klmnopqrst98765");

    const result = await runCompile({
      perFileMaxBytes: 10,
      totalMaxBytes: 15,
    });

    expect(result.rawFilesIncluded).toEqual([first, second]);
    expect(result.truncatedAtTotalCap).toBe(true);
    expect(result.prompt).toContain("abcdefghij");
    expect(result.prompt).toContain("klmno");
    expect(result.prompt).not.toContain("pqrst");
    expect(result.prompt).toContain("[truncated");
  });

  it("skips remaining files once total cap is exhausted", async () => {
    const first = join(root, "raw", "2026-05-21", "manual-a.md");
    const second = join(root, "raw", "2026-05-21", "manual-b.md");
    await writeFile(first, "abcde");
    await writeFile(second, "fghij");

    const result = await runCompile({
      perFileMaxBytes: 10,
      totalMaxBytes: 5,
    });

    expect(result.rawFilesIncluded).toEqual([first]);
    expect(result.rawFilesSkipped).toEqual([
      { path: second, reason: "totalMaxBytes reached" },
    ]);
    expect(result.truncatedAtTotalCap).toBe(true);
  });

  it("writes to outputPath and still returns the prompt", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    const outputPath = join(tmp, "compile-prompt.md");
    await writeFile(rawPath, "raw for output");

    const result = await runCompile({ outputPath });

    expect(existsSync(outputPath)).toBe(true);
    expect(await readFile(outputPath, "utf-8")).toBe(result.prompt);
  });

  it("--output writes file and suppresses prompt on stdout", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    const outputPath = join(tmp, "compile-cli-prompt.md");
    await writeFile(rawPath, "raw for cli output");

    const r = spawnSync("node", [CLI, "compile", "--output", outputPath], {
      encoding: "utf-8",
      env: { ...process.env, MEMORY_ROOT: root },
    });

    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(r.stderr).toContain(`Compile prompt written to ${outputPath}`);
    expect(existsSync(outputPath)).toBe(true);
    expect(await readFile(outputPath, "utf-8")).toContain("SCHEMA=# Schema");
  });
});
