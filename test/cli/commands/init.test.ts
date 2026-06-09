import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";

describe("runInit", () => {
  let tmp: string;
  let origMemRoot: string | undefined;
  let sourceRepoDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "meminit-"));
    origMemRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = join(tmp, ".memory");
    sourceRepoDir = process.cwd();
  });

  afterEach(async () => {
    if (origMemRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMemRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates the full directory structure", async () => {
    const result = await runInit({ sourceRepoDir });
    expect(existsSync(result.root)).toBe(true);
    expect(existsSync(join(result.root, "raw"))).toBe(true);
    expect(existsSync(join(result.root, "wiki", "projects"))).toBe(true);
    expect(existsSync(join(result.root, "wiki", "issues"))).toBe(true);
    expect(existsSync(join(result.root, "wiki", "lessons"))).toBe(true);
    expect(existsSync(join(result.root, "wiki", "threads"))).toBe(true);
    expect(existsSync(join(result.root, "wiki", "threads-proposed"))).toBe(true);
    expect(existsSync(join(result.root, "wiki", "procedures"))).toBe(true);
    expect(existsSync(join(result.root, "wiki", "procedures-proposed"))).toBe(true);
    expect(existsSync(join(result.root, "crystals"))).toBe(true);
    expect(existsSync(join(result.root, "embeddings"))).toBe(true);
    expect(existsSync(join(result.root, ".archive"))).toBe(true);
  });

  it("--dry-run reports the init plan without writing the vault", async () => {
    const writes: string[] = [];
    const result = await runInit({
      sourceRepoDir,
      dryRun: true,
      stdout: captureStdout(writes, false),
    });

    expect(result.dryRun).toBe(true);
    expect(writes.join("")).toContain("memory init will write");
    expect(result.planned?.some((line) => line.includes("config.yaml"))).toBe(true);
    expect(existsSync(result.root)).toBe(false);
  });

  it("prompts before writing when stdout is a TTY", async () => {
    let promptCalls = 0;
    const writes: string[] = [];

    const result = await runInit({
      sourceRepoDir,
      stdout: captureStdout(writes, true),
      confirm: async (question) => {
        promptCalls += 1;
        expect(question).toBe("Proceed? [Y/n] ");
        return true;
      },
    });

    expect(promptCalls).toBe(1);
    expect(writes.join("")).toContain("memory init will write");
    expect(existsSync(result.root)).toBe(true);
  });

  it("--yes skips the TTY prompt", async () => {
    let promptCalls = 0;

    const result = await runInit({
      sourceRepoDir,
      yes: true,
      stdout: captureStdout([], true),
      confirm: async () => {
        promptCalls += 1;
        return false;
      },
    });

    expect(promptCalls).toBe(0);
    expect(existsSync(result.root)).toBe(true);
  });

  it("writes the baseline files", async () => {
    const result = await runInit({ sourceRepoDir });
    expect(existsSync(join(result.root, "schema.md"))).toBe(true);
    expect(existsSync(join(result.root, "index.md"))).toBe(true);
    expect(existsSync(join(result.root, "log.md"))).toBe(true);
    expect(existsSync(join(result.root, "config.yaml"))).toBe(true);
    expect(existsSync(join(result.root, "errors.log"))).toBe(true);
    expect(existsSync(join(result.root, "wiki", "preferences.md"))).toBe(true);
    expect(existsSync(join(result.root, ".gitignore"))).toBe(true);
    expect(existsSync(join(result.root, ".gitattributes"))).toBe(true);
    expect(existsSync(join(result.root, "prompts", "compile.md"))).toBe(true);
    expect(existsSync(join(result.root, "prompts", "lint.md"))).toBe(true);
    expect(existsSync(join(result.root, "prompts", "hyde.md"))).toBe(true);
    const gitignore = await readFile(join(result.root, ".gitignore"), "utf-8");
    expect(gitignore).toContain("errors.log");
    expect(gitignore).toContain(".archive/");
    expect(gitignore).toContain("embeddings/");
    expect(gitignore).toContain("wiki/.audit/llm-debug-*.md");
    expect(gitignore).not.toContain(".gitattributes");
    expect(gitignore).toContain("claude-code-plugin/");
    expect(gitignore).not.toContain("embeddings/raw.*.jsonl");
    expect(gitignore).not.toContain("raw/");
    const gitattributes = await readFile(
      join(result.root, ".gitattributes"),
      "utf-8",
    );
    expect(gitattributes).toContain("*.md text eol=lf");
    expect(gitattributes).toContain("*.yaml text eol=lf");
    expect(gitattributes).toContain("*.json text eol=lf");
    const preferences = await readFile(join(result.root, "wiki", "preferences.md"), "utf-8");
    expect(preferences).toContain("title: Operator Preferences");
    expect(preferences).toContain("tags: [preference]");
    const config = await readFile(join(result.root, "config.yaml"), "utf-8");
    expect(config).toContain("auto_heal:");
    expect(config).toContain("enabled: false");
    expect(config).toContain("daily_budget_usd: 0.50");
    expect(config).toContain("compress:");
    expect(config).toContain("max_input_bytes: 48000");
    expect(config).toContain("chunk_threshold_bytes: 48000");
    expect(config).toContain("max_chunks: 8");
    expect(config).toContain("max_call_tokens: 100000");
  });

  it("renders schema.md template with no placeholders remaining", async () => {
    const result = await runInit({
      sourceRepoDir,
      now: new Date(Date.UTC(2026, 4, 21)),
    });
    const schema = await readFile(join(result.root, "schema.md"), "utf-8");
    expect(schema).toContain("2026-05-21");
    expect(schema).not.toContain("{{install_commit}}");
    expect(schema).toMatch(/applies_from_commit: "([0-9a-f]{7,40}|unknown|test)"/);
    expect(schema).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it("is idempotent and preserves existing files", async () => {
    await runInit({ sourceRepoDir });
    const firstSchema = await readFile(
      join(process.env["MEMORY_ROOT"]!, "schema.md"),
      "utf-8",
    );
    const result = await runInit({ sourceRepoDir });
    expect(result.preserved.length).toBeGreaterThan(0);
    const secondSchema = await readFile(
      join(process.env["MEMORY_ROOT"]!, "schema.md"),
      "utf-8",
    );
    expect(secondSchema).toBe(firstSchema);
  });

  it("--reset archives existing memory under .archive", async () => {
    await runInit({ sourceRepoDir });
    const result = await runInit({
      sourceRepoDir,
      reset: true,
      now: new Date(Date.UTC(2026, 4, 22)),
    });
    expect(result.archivedTo).toBeDefined();
    expect(result.archivedTo!).toContain(`${join(".memory", ".archive")}`);
    expect(existsSync(result.archivedTo!)).toBe(true);
    expect(existsSync(result.root)).toBe(true);
  });

  it("appends to log.md on second invocation", async () => {
    await runInit({
      sourceRepoDir,
      now: new Date(Date.UTC(2026, 4, 21, 10)),
    });
    await runInit({
      sourceRepoDir,
      now: new Date(Date.UTC(2026, 4, 21, 11)),
    });
    const log = await readFile(
      join(process.env["MEMORY_ROOT"]!, "log.md"),
      "utf-8",
    );
    const initLines = (log.match(/\] init \|/g) ?? []).length;
    expect(initLines).toBe(2);
  });

  it("initializes git inside ~/.memory/ when git is available", async () => {
    const result = await runInit({ sourceRepoDir });
    if (existsSync(join(result.root, ".git"))) {
      expect(existsSync(join(result.root, ".git", "HEAD"))).toBe(true);
      const tracked = execFileSync("git", ["ls-files", ".gitattributes"], {
        cwd: result.root,
        encoding: "utf-8",
      }).trim();
      expect(tracked).toBe(".gitattributes");
      const trackedPreferences = execFileSync("git", ["ls-files", "wiki/preferences.md"], {
        cwd: result.root,
        encoding: "utf-8",
      }).trim();
      expect(trackedPreferences).toBe("wiki/preferences.md");
    }
  });
});

function captureStdout(writes: string[], isTTY: boolean) {
  return {
    isTTY,
    write(chunk: string | Uint8Array): boolean {
      writes.push(String(chunk));
      return true;
    },
  };
}
