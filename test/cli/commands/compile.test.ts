import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { formatCompileExecuteSummary, runCompile, runCompileDrain, type CompileResult } from "../../../src/cli/commands/compile.js";
import { readCompileStateFile, writeCompileStateFile } from "../../../src/compile/state.js";
import type { LLMProvider } from "../../../src/llm/types.js";

const CLI = resolve(process.cwd(), "dist", "cli.mjs");

const TEMPLATE = [
  "# memory:custom",
  "SCHEMA={{schema_content}}",
  "INDEX={{index_content}}",
  "EXISTING={{existing_pages}}",
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

  it("injects the condensed index into the compile prompt by default", async () => {
    await writeFile(
      join(root, "index.md"),
      [
        "## Projects",
        "",
        "- [Alpha](wiki/projects/alpha.md) - 12345678901234567890123456789012345678901234567890tail",
        "- [Beta](wiki/projects/beta.md) - Short description",
        "",
      ].join("\n"),
    );

    const result = await runCompile({ vaultRoot: root });

    expect(result.prompt).toContain(
      "INDEX=## Projects\n\n- [Alpha](wiki/projects/alpha.md) - 12345678901234567890123456789012345678901234567890...",
    );
    expect(result.prompt).toContain("- [Beta](wiki/projects/beta.md) - Short description");
    expect(result.prompt).not.toContain("tail");
  });

  it("injects raw index.md byte-identically when condensed_index is disabled", async () => {
    const rawIndex = [
      "## Projects",
      "",
      "- [Alpha](wiki/projects/alpha.md) - 12345678901234567890123456789012345678901234567890tail",
      "",
    ].join("\n");
    await writeFile(join(root, "index.md"), rawIndex);

    const result = await runCompile({
      vaultRoot: root,
      configLoader: async () => ({ compile: { condensed_index: false } }),
    });

    expect(result.prompt).toContain(`INDEX=${rawIndex}`);
  });

  it("uses the bundled compile prompt when the vault prompt is not customized", async () => {
    const sourceRepoDir = join(tmp, "source");
    await mkdir(join(sourceRepoDir, "templates", "prompts"), { recursive: true });
    await writeFile(
      join(sourceRepoDir, "templates", "prompts", "compile.md"),
      [
        "<!-- memory:template compile:test -->",
        "BUNDLED={{schema_content}}",
      ].join("\n"),
    );
    await writeFile(join(root, "prompts", "compile.md"), "STALE={{schema_content}}\n");
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runCompile({ vaultRoot: root, sourceRepoDir });

    expect(result.prompt).toContain("BUNDLED=# Schema");
    expect(result.prompt).not.toContain("STALE=");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("memory sync-prompts --apply"));
    warnSpy.mockRestore();
  });

  it("injects referenced existing page bodies into the compile prompt", async () => {
    await writeFile(
      join(root, "wiki", "projects", "agentmemory.md"),
      [
        "---",
        "type: projects",
        "title: agentmemory",
        "created: 2026-05-30",
        "updated: 2026-05-30",
        "---",
        "",
        "agentmemory already stores durable project memory.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "raw", "2026-05-21", "manual-a.md"),
      "agentmemory already stores durable project memory and was mentioned again.",
    );

    const result = await runCompile({ vaultRoot: root });

    expect(result.prompt).toContain("EXISTING=### wiki/projects/agentmemory.md");
    expect(result.prompt).toContain("agentmemory already stores durable project memory.");
    expect(result.prompt).not.toMatch(/\{\{existing_pages\}\}/);
  });

  it("never injects archive or system wiki pages into the compile context", async () => {
    await mkdir(join(root, "wiki", "Archive"), { recursive: true });
    await writeFile(
      join(root, "wiki", "Archive", "retained.md"),
      "ARCHIVE_CONTEXT_MUST_NOT_REACH_THE_LLM",
    );
    await writeFile(
      join(root, "wiki", "projects", ".retained.md"),
      "SYSTEM_CONTEXT_MUST_NOT_REACH_THE_LLM",
    );
    await mkdir(join(root, "wiki", "_archive"), { recursive: true });
    await writeFile(
      join(root, "wiki", "_archive", "retained.md"),
      "MAINTENANCE_ARCHIVE_CONTEXT_MUST_NOT_REACH_THE_LLM",
    );
    await writeFile(
      join(root, "raw", "2026-05-21", "manual-a.md"),
      "retained archive and retained system pages were mentioned again.",
    );

    const result = await runCompile({ vaultRoot: root });

    expect(result.prompt).not.toContain("ARCHIVE_CONTEXT_MUST_NOT_REACH_THE_LLM");
    expect(result.prompt).not.toContain("SYSTEM_CONTEXT_MUST_NOT_REACH_THE_LLM");
    expect(result.prompt).not.toContain("MAINTENANCE_ARCHIVE_CONTEXT_MUST_NOT_REACH_THE_LLM");
    expect(result.prompt).not.toContain("wiki/Archive/retained.md");
    expect(result.prompt).not.toContain("wiki/projects/.retained.md");
    expect(result.prompt).not.toContain("wiki/_archive/retained.md");
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

  it("orders eligible raws by least recently consumed before applying budget", async () => {
    const newConsumed = join(root, "raw", "2026-05-21", "a-new.md");
    const oldConsumed = join(root, "raw", "2026-05-21", "b-old.md");
    const neverConsumed = join(root, "raw", "2026-05-21", "z-never.md");
    await writeFile(newConsumed, "xnew tail");
    await writeFile(oldConsumed, "xold tail");
    await writeFile(neverConsumed, "never tail");
    await writeCompileState({
      consumed: {
        "raw/2026-05-21/a-new.md": {
          bytes: 1,
          lastObservationAt: "2026-05-21T12:00:00.000Z",
        },
        "raw/2026-05-21/b-old.md": {
          bytes: 1,
          lastObservationAt: "2026-05-21T10:00:00.000Z",
        },
      },
    });

    const result = await runCompile({
      vaultRoot: root,
      perFileMaxBytes: 20,
      totalMaxBytes: 100,
    });

    expect(result.rawFilesIncluded).toEqual([
      neverConsumed,
      oldConsumed,
      newConsumed,
    ]);
  });

  it("uses remaining total budget for additional fair allocation cycles", async () => {
    const first = join(root, "raw", "2026-05-21", "manual-a.md");
    const second = join(root, "raw", "2026-05-21", "manual-b.md");
    await writeFile(first, "abcdefghij");
    await writeFile(second, "1234567890");

    const result = await runCompile({
      vaultRoot: root,
      perFileMaxBytes: 3,
      totalMaxBytes: 9,
    });

    expect(result.rawFilesIncluded).toEqual([first, second]);
    expect(result.prompt).toContain("abcde");
    expect(result.prompt).toContain("1234");
    expect(result.prompt).not.toContain("123456");
  });

  it("advances a late never-consumed large file even when earlier files could fill the cap", async () => {
    for (let i = 0; i < 25; i += 1) {
      await writeFile(
        join(root, "raw", "2026-05-21", `a-small-${String(i).padStart(2, "0")}.md`),
        `small-${String(i).padStart(2, "0")}`,
      );
    }
    const large = join(root, "raw", "2026-05-21", "z-large.md");
    await writeFile(large, "L".repeat(100));
    // Corroborating raw paths so multi-source write_page applies (not stages).
    // Fully consume them so they do not compete for the fair-allocation budget.
    const aBody = "corroboration-a\n";
    const bBody = "corroboration-b\n";
    await writeFile(join(root, "raw", "2026-05-21", "manual-a.md"), aBody);
    await writeFile(join(root, "raw", "2026-05-21", "manual-b.md"), bBody);
    await writeCompileState({
      consumed: {
        "raw/2026-05-21/manual-a.md": { bytes: Buffer.byteLength(aBody, "utf-8") },
        "raw/2026-05-21/manual-b.md": { bytes: Buffer.byteLength(bBody, "utf-8") },
      },
    });

    await runCompile({
      vaultRoot: root,
      execute: true,
      perFileMaxBytes: 10,
      totalMaxBytes: 50,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeExecuteLLM(),
      env: {},
    });

    const state = await readCompileState();
    expect(state.consumed["raw/2026-05-21/z-large.md"].bytes).toBeGreaterThan(0);
  });

  it("does not split timestamped raw observations mid-record", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    const firstRecord = rawObservation("09:00:00", "first complete observation");
    const secondRecord = rawObservation("09:01:00", "second observation should wait");
    await writeFile(rawPath, firstRecord + secondRecord);

    const result = await runCompile({
      vaultRoot: root,
      perFileMaxBytes: Buffer.byteLength(firstRecord, "utf-8") + 8,
      totalMaxBytes: Buffer.byteLength(firstRecord, "utf-8") + 8,
    });

    expect(result.prompt).toContain("first complete observation");
    expect(result.prompt).not.toContain("second observation should wait");
  });

  it("shares a small total cap instead of skipping later eligible files", async () => {
    const first = join(root, "raw", "2026-05-21", "manual-a.md");
    const second = join(root, "raw", "2026-05-21", "manual-b.md");
    await writeFile(first, "abcde");
    await writeFile(second, "fghij");

    const result = await runCompile({
      perFileMaxBytes: 10,
      totalMaxBytes: 5,
    });

    expect(result.rawFilesIncluded).toEqual([first, second]);
    expect(result.rawFilesSkipped).toEqual([]);
    expect(result.prompt).toContain("abcd");
    expect(result.prompt).toContain("f");
    expect(result.prompt).not.toContain("ghij");
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

  it("executes compile-ops via audited LLM response when explicitly requested", async () => {
    await writeFile(join(root, "raw", "2026-05-21", "manual-a.md"), "raw for execute a");
    await writeFile(join(root, "raw", "2026-05-21", "manual-b.md"), "raw for execute b");

    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeExecuteLLM(),
      env: {},
    });

    expect(result.execution).toMatchObject({
      mode: "execute",
      applied: ["wiki/lessons/compile-execute.md"],
      proposed: [],
      planned: [],
      outcomes: [
        {
          path: "wiki/lessons/compile-execute.md",
          outcome: "created",
          contentPreserved: true,
        },
      ],
    });
    expect(await readFile(join(root, "wiki", "lessons", "compile-execute.md"), "utf-8"))
      .toContain("Compile execute body");
    expect(await readFile(join(root, "wiki", ".audit", `llm-${new Date().toISOString().slice(0, 10)}.md`), "utf-8"))
      .toContain("| compile-execute |");
  });

  it("skips raw files already consumed to their watermark", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    const content = "already consolidated raw";
    await writeFile(rawPath, content);
    await writeCompileState({
      consumed: {
        "raw/2026-05-21/manual-a.md": {
          bytes: Buffer.byteLength(content, "utf-8"),
          lastObservationAt: "2026-05-21T10:00:00.000Z",
        },
      },
    });

    const result = await runCompile({ vaultRoot: root });

    expect(result.rawFilesIncluded).toEqual([]);
    expect(result.rawFilesSkipped).toEqual([
      { path: rawPath, reason: "already consumed to watermark" },
    ]);
    expect(result.prompt).not.toContain(content);
  });

  it("re-includes a fully-consumed raw edited in place to the SAME byte length (content-hashed watermark)", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-b.md");
    const oldContent = "AAAAAAAAAAAA edited later";
    await writeFile(rawPath, oldContent);
    await writeCompileState({
      consumed: {
        "raw/2026-05-21/manual-b.md": {
          bytes: Buffer.byteLength(oldContent, "utf-8"),
          mtimeMs: 1, // stale; the live file's mtime will differ after the edit
          sourceHash: createHash("sha256").update(Buffer.from(oldContent, "utf-8")).digest("hex"),
          lastObservationAt: "2026-05-21T10:00:00.000Z",
        },
      },
    });
    // Same byte length, different content.
    const newContent = "BBBBBBBBBBBB edited later";
    expect(newContent.length).toBe(oldContent.length);
    await writeFile(rawPath, newContent);

    const result = await runCompile({ vaultRoot: root });

    expect(result.rawFilesSkipped?.some((s) => s.path === rawPath)).toBe(false);
    expect(result.rawFilesIncluded).toContain(rawPath);
    expect(result.prompt).toContain(newContent);
  });

  it("still skips a fully-consumed raw whose content hash matches (a no-op touch / git checkout mtime bump)", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-c.md");
    const content = "unchanged content, only mtime moved";
    await writeFile(rawPath, content);
    await writeCompileState({
      consumed: {
        "raw/2026-05-21/manual-c.md": {
          bytes: Buffer.byteLength(content, "utf-8"),
          mtimeMs: 1, // stale mtime forces the hash check
          sourceHash: createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex"),
          lastObservationAt: "2026-05-21T10:00:00.000Z",
        },
      },
    });

    const result = await runCompile({ vaultRoot: root });

    expect(result.rawFilesIncluded).toEqual([]);
    expect(result.rawFilesSkipped).toEqual([
      { path: rawPath, reason: "already consumed to watermark" },
    ]);
  });

  it("advances the watermark after execute and only sends an appended tail on the next run", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    await writeFile(rawPath, "first observation\n");
    // Second raw must exist on disk: grounding strips missing derived_from refs,
    // and multi-source confidence is required for write_page to apply (not stage).
    // Mark b fully consumed so it does not re-enter the included set after pass 1.
    const bBody = "corroboration\n";
    await writeFile(join(root, "raw", "2026-05-21", "manual-b.md"), bBody);
    await writeCompileState({
      consumed: {
        "raw/2026-05-21/manual-b.md": {
          bytes: Buffer.byteLength(bBody, "utf-8"),
        },
      },
    });
    const llm = fakeExecuteLLMWith(({ prompt }) => [{
      kind: "write_page",
      path: "wiki/lessons/watermark.md",
      frontmatter: {
        type: "lessons",
        title: "Watermark",
        relations: {
          derived_from: [
            "raw/2026-05-21/manual-a.md",
            "raw/2026-05-21/manual-b.md",
          ],
        },
      },
      body: prompt.includes("second observation") ? "Second only." : "First only.",
    }]);

    const first = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
    });
    expect(first.execution?.applied).toContain("wiki/lessons/watermark.md");
    expect(first.watermarksAdvanced).toContain("raw/2026-05-21/manual-a.md");

    await writeFile(rawPath, "first observation\nsecond observation\n");

    const second = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
    });

    expect(second.prompt).not.toContain("first observation");
    expect(second.prompt).toContain("second observation");
    const state = await readCompileState();
    expect(state.consumed["raw/2026-05-21/manual-a.md"].bytes)
      .toBe(Buffer.byteLength("first observation\nsecond observation\n", "utf-8"));
  });

  it("holds canonical writes and raw watermarks for a parseable non-stop compile response", async () => {
    await writeFile(join(root, "raw", "2026-05-21", "manual-a.md"), "first source observation\n");
    await writeFile(join(root, "raw", "2026-05-21", "manual-b.md"), "second source observation\n");

    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeExecuteLLMWith(() => [{
        kind: "write_page",
        path: "wiki/lessons/nonstop-response.md",
        frontmatter: {
          type: "lessons",
          title: "Non-stop response",
          relations: { derived_from: ["raw/2026-05-21/manual-a.md", "raw/2026-05-21/manual-b.md"] },
        },
        body: "This parseable mutation must not apply after a non-stop response.",
      }], { finishReason: "error" }),
      env: {},
    });

    expect(result.execution?.outcomes).toEqual([expect.objectContaining({
      path: "(response)",
      outcome: "rejected",
      reason: expect.stringContaining("unverifiable"),
    })]);
    expect(result.watermarksAdvanced).toEqual([]);
    expect(existsSync(join(root, "wiki", "lessons", "nonstop-response.md"))).toBe(false);
    const state = await readCompileState();
    expect(state.consumed ?? {}).not.toHaveProperty("raw/2026-05-21/manual-a.md");
    expect(state.consumed ?? {}).not.toHaveProperty("raw/2026-05-21/manual-b.md");
  });

  it("does not advance the watermark when execute only stages proposals", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    const body = "single-source observation that should stage not apply\n";
    await writeFile(rawPath, body);

    // One derived_from raw ref fails multi-source confidence → staged-for-review.
    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeExecuteLLMWith(() => [{
        kind: "write_page",
        path: "wiki/lessons/staged-only.md",
        frontmatter: {
          type: "lessons",
          title: "Staged Only",
          relations: { derived_from: ["raw/2026-05-21/manual-a.md"] },
        },
        body: "Should land in compile-proposed only.",
      }]),
      env: {},
    });

    expect(result.execution?.applied).toEqual([]);
    expect(result.execution?.proposed.length).toBeGreaterThan(0);
    expect(result.watermarksAdvanced).toEqual([]);
    const state = await readCompileState();
    expect(state.consumed ?? {}).not.toHaveProperty("raw/2026-05-21/manual-a.md");

    // Same raw bytes remain eligible on the next run (not permanently skipped).
    const second = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeExecuteLLM(),
      env: {},
    });
    expect(second.rawFilesIncluded).toContain(rawPath);
    expect(second.prompt).toContain("single-source observation");
  });

  it("does not advance raw watermarks when execute consolidates compressed facts instead of the raw prompt", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    await writeFile(rawPath, "raw prompt content that fact consolidation did not consume\n");
    await writeFile(
      join(root, "wiki", "projects", "memory-system.md"),
      [
        "---",
        "type: projects",
        "title: Memory System",
        "created: 2026-05-31",
        "updated: 2026-05-31",
        "status: active",
        "lifecycle: consolidated",
        "source: compile-execute",
        "version: 1",
        "---",
        "",
        "Memory System captures raw observations.",
        "",
      ].join("\n"),
    );
    for (const id of ["a", "b", "c"]) {
      await writeFact(`facts/2026-05-31/${id}.json`, {
        title: `Memory System ${id}`,
        facts: [`Memory System fact ${id}.`],
        narrative: `Memory System narrative ${id}.`,
        concepts: ["Memory System"],
        files: [],
        importance: 8,
        sessionId: id,
        sourceRawPath: `raw/2026-05-31/${id}.md`,
        observedAt: "2026-05-31T12:00:00.000Z",
        compressedAt: "2026-05-31T12:00:00.000Z",
      });
    }

    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeFactConsolidationLLM(),
      env: {},
    });

    const state = await readCompileStateFile(root);
    expect(result.execution?.applied).toEqual(["wiki/projects/memory-system.md"]);
    expect(result.rawFilesIncluded).toEqual([rawPath]);
    expect(result.watermarksAdvanced).toEqual([]);
    expect(state.consumed ?? {}).not.toHaveProperty("raw/2026-05-21/manual-a.md");
  });

  it("falls through to prompt-based raw execution when fact consolidation has no candidates", async () => {
    // Regression: leftover facts with no matching wiki page used to shadow
    // the raw compile path on EVERY execute run — applied 0, watermark
    // frozen, wiki starved.
    await writeFile(join(root, "raw", "2026-05-21", "manual-a.md"), "raw observation that must reach the prompt path\n");
    await writeFile(join(root, "raw", "2026-05-21", "manual-b.md"), "second raw observation\n");
    await writeFact("facts/2026-05-31/orphan.json", {
      title: "Orphan Concept",
      facts: ["Orphan fact with no matching page."],
      narrative: "Orphan narrative.",
      concepts: ["Concept With No Page"],
      files: [],
      importance: 8,
      sessionId: "orphan",
      sourceRawPath: "raw/2026-05-31/orphan.md",
      observedAt: "2026-05-31T12:00:00.000Z",
      compressedAt: "2026-05-31T12:00:00.000Z",
    });

    const result = await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeExecuteLLM(),
      env: {},
    });

    expect(result.execution?.applied).toEqual(["wiki/lessons/compile-execute.md"]);
    const state = await readCompileState();
    expect(state.consumed["raw/2026-05-21/manual-a.md"]?.bytes).toBeGreaterThan(0);
  });

  it("does not advance the watermark in artifact mode", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    await writeFile(rawPath, "abcdef");
    await writeCompileState({
      consumed: {
        "raw/2026-05-21/manual-a.md": { bytes: 3, lastObservationAt: "2026-05-21T10:00:00.000Z" },
      },
    });

    const result = await runCompile({ vaultRoot: root });

    expect(result.prompt).toContain("def");
    const state = await readCompileState();
    expect(state.consumed["raw/2026-05-21/manual-a.md"].bytes).toBe(3);
  });

  it("advances only to bytes included when raw content is capped", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    await writeFile(rawPath, "abcdefghij");
    // Corroborating source exists for multi-source apply, but is already fully
    // consumed so it does not steal budget from the file under test.
    const bBody = "corroboration\n";
    await writeFile(join(root, "raw", "2026-05-21", "manual-b.md"), bBody);
    await writeCompileState({
      consumed: {
        "raw/2026-05-21/manual-b.md": {
          bytes: Buffer.byteLength(bBody, "utf-8"),
        },
      },
    });

    await runCompile({
      vaultRoot: root,
      execute: true,
      perFileMaxBytes: 5,
      totalMaxBytes: 5,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeExecuteLLM(),
      env: {},
    });

    const state = await readCompileState();
    expect(state.consumed["raw/2026-05-21/manual-a.md"].bytes).toBe(5);

    const next = await runCompile({ vaultRoot: root });
    expect(next.prompt).not.toContain("abcde");
    expect(next.prompt).toContain("fghij");
  });

  it("drains compile passes until no raw files remain", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    await writeFile(rawPath, "abcdefghij");
    const bBody = "corroboration\n";
    await writeFile(join(root, "raw", "2026-05-21", "manual-b.md"), bBody);
    await writeCompileState({
      consumed: {
        "raw/2026-05-21/manual-b.md": {
          bytes: Buffer.byteLength(bBody, "utf-8"),
        },
      },
    });
    const progress: string[] = [];

    const result = await runCompileDrain({
      vaultRoot: root,
      execute: true,
      perFileMaxBytes: 3,
      totalMaxBytes: 3,
      maxPasses: 10,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeExecuteLLMWhenRawPresent(),
      env: {},
      onProgress: (line) => progress.push(line),
    });

    expect(result.stopReason).toBe("empty");
    expect(result.passes.at(-1)?.rawFilesIncluded).toEqual([]);
    expect(result.totalRawFilesIncluded).toBe(4);
    expect(progress).toContain("pass 1: included 1 raw file(s), advanced 1 watermark(s), remaining 7 byte(s) in 1 file(s)");
    const state = await readCompileState();
    expect(state.consumed["raw/2026-05-21/manual-a.md"].bytes).toBe(10);
  });

  it("rejects drain mode without execute", async () => {
    await expect(runCompileDrain({
      vaultRoot: root,
      execute: false,
    })).rejects.toThrow("memory compile: --drain requires --execute");
  });

  it("--since bypasses recorded watermarks", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    await writeFile(rawPath, "force backfill raw");
    await writeCompileState({
      consumed: {
        "raw/2026-05-21/manual-a.md": {
          bytes: Buffer.byteLength("force backfill raw", "utf-8"),
          lastObservationAt: "2026-05-21T10:00:00.000Z",
        },
      },
    });

    const result = await runCompile({ vaultRoot: root, since: "2026-05-01T00:00:00.000Z" });

    expect(result.rawFilesIncluded).toEqual([rawPath]);
    expect(result.prompt).toContain("force backfill raw");
  });

  it("clears matching consumed watermarks before compiling", async () => {
    await writeFile(join(root, "raw", "2026-05-21", "manual-a.md"), "a");
    await writeFile(join(root, "raw", "2026-05-21", "manual-b.md"), "b");
    await writeCompileState({
      consumed: {
        "raw/2026-05-21/manual-a.md": { bytes: 1 },
        "raw/2026-05-21/manual-b.md": { bytes: 1 },
      },
    });

    const result = await runCompile({
      vaultRoot: root,
      resetWatermark: "raw/2026-05-21/manual-a.md",
    });

    expect(result.rawFilesIncluded).toEqual([join(root, "raw", "2026-05-21", "manual-a.md")]);
    expect(result.rawFilesSkipped).toContainEqual({
      path: join(root, "raw", "2026-05-21", "manual-b.md"),
      reason: "already consumed to watermark",
    });
    const state = await readCompileState();
    expect(state.consumed).not.toHaveProperty("raw/2026-05-21/manual-a.md");
    expect(state.consumed).toHaveProperty("raw/2026-05-21/manual-b.md");
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

  it("formats execute summaries with honest pending-tail labels", () => {
    const lines = formatCompileExecuteSummary({
      rawFilesIncluded: Array.from({ length: 40 }, (_, index) => `raw/${index}.md`),
      rawFilesRemaining: 6,
      pendingSummary: {
        filesWithPendingTail: 2,
        pendingTailBytes: 9,
        totalRawFiles: 10,
        filesFullyDrained: 3,
        filesUnseen: 5,
      },
      execution: {
        mode: "execute",
        rawInputConsumed: true,
        applied: [],
        proposed: [],
        planned: [],
        rejected: [],
        outcomes: [],
        referencesStripped: 0,
        prosePathLeaks: 0,
        pagesRewritten: 0,
        pagesUpdated: 0,
        pagesUnchanged: 2,
        factsExtracted: 0,
        sessionsScanned: 603,
      },
    } as CompileResult);

    expect(lines).toContain("Consolidated 40 observations -> 0 applied, 0 staged, 0 rejected.");
    expect(lines).toContain("Pending tails: 2 raw files have fresh content since the last compile read them (9 bytes).");
    expect(lines).toContain("Already-drained: 3 raw files have no new bytes since the last pass.");
    expect(lines).toContain("Future batches: 6 raw files queued for upcoming runs (batch cap 40).");
    expect(lines).toContain("603 sessions scanned. 2 pages unchanged.");
    expect(lines.join("\n")).not.toMatch(/observations remaining|raw files skipped|staged for review/i);
  });
});

function fakeExecuteLLM(): LLMProvider {
  return fakeExecuteLLMWith(() => [{
    kind: "write_page",
    path: "wiki/lessons/compile-execute.md",
    frontmatter: {
      type: "lessons",
      title: "Compile Execute",
      relations: {
        derived_from: [
          "raw/2026-05-21/manual-a.md",
          "raw/2026-05-21/manual-b.md",
        ],
      },
    },
    body: "Compile execute body.",
  }]);
}

function fakeExecuteLLMWhenRawPresent(): LLMProvider {
  return fakeExecuteLLMWith(({ prompt }) => {
    if (prompt.includes("RAW=(none)")) return [];
    const rawSlice = /```markdown\n([\s\S]*?)\n```/.exec(prompt)?.[1] ?? "raw";
    return [{
      kind: "write_page",
      path: "wiki/lessons/compile-drain.md",
      frontmatter: {
        type: "lessons",
        title: "Compile Drain",
        relations: {
          // Dual raw refs (files must exist) so the op applies and watermarks advance.
          derived_from: [
            "raw/2026-05-21/manual-a.md",
            "raw/2026-05-21/manual-b.md",
          ],
        },
      },
      body: `Compile drain body: ${rawSlice}`,
    }];
  });
}

function fakeExecuteLLMWith(
  operations: (opts: { prompt: string }) => unknown[],
  responseOptions: { finishReason?: import("../../../src/llm/types.js").LLMFinishReason } = {},
): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async (request) => {
      if (request.jsonSchema?.name === "FaithfulnessOutput") {
        return {
          model: "llama3.2",
          finishReason: "stop" as const,
          rawProviderName: "ollama",
          content: JSON.stringify({ unsupported_claims: [] }),
        };
      }
      if (request.jsonSchema?.name === "NarrativeDetectOutput") {
        return {
          model: "llama3.2",
          finishReason: "stop" as const,
          rawProviderName: "ollama",
          content: JSON.stringify({ contradicted_claims: [], net_new_facts: ["generated compile update"] }),
        };
      }
      if (request.jsonSchema?.name === "NarrativeSynthesisOutput") {
        const prompt = request.messages.at(-1)?.content ?? "";
        const current = /Current body:\n([\s\S]*?)\n\nContradicted claims:/.exec(prompt)?.[1]?.trim() ?? "";
        const encodedNarrative = /"narrative":\s*"((?:\\.|[^"\\])*)"/.exec(prompt)?.[1];
        const incoming = encodedNarrative ? JSON.parse(`"${encodedNarrative}"`) : "generated compile update";
        return {
          model: "llama3.2",
          finishReason: "stop" as const,
          rawProviderName: "ollama",
          content: JSON.stringify({ body: [current, incoming].filter(Boolean).join("\n\n") }),
        };
      }
      return {
        model: "llama3.2",
        finishReason: responseOptions.finishReason ?? "stop",
        rawProviderName: "ollama",
        content: [
          "```compile-ops",
          JSON.stringify({
            operations: operations({
              prompt: request.messages.map((message) => message.content).join("\n"),
            }),
          }),
          "```",
        ].join("\n"),
      };
    }),
  };
}

async function writeCompileState(state: Record<string, unknown>): Promise<void> {
  await writeCompileStateFile(rootForTest(), state);
}

async function writeFact(relPath: string, fact: Record<string, unknown>): Promise<void> {
  const fullPath = join(rootForTest(), ...relPath.split("/"));
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify({ facts: [fact] }, null, 2)}\n`);
}

async function readCompileState(): Promise<{ consumed: Record<string, { bytes: number; lastObservationAt?: string }> }> {
  return await readCompileStateFile(rootForTest()) as { consumed: Record<string, { bytes: number; lastObservationAt?: string }> };
}

function rootForTest(): string {
  const root = process.env["MEMORY_ROOT"];
  if (!root) throw new Error("MEMORY_ROOT missing in compile test");
  return root;
}

function rawObservation(time: string, body: string): string {
  return `## [${time}] Prompt\n\n${body}\n\n`;
}

function fakeFactConsolidationLLM(): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async (request) => {
      if (request.jsonSchema?.name === "NarrativeDetectOutput") {
        return fakeJsonResponse(JSON.stringify({
          contradicted_claims: [],
          net_new_facts: ["Memory System fact a.", "Memory System fact b.", "Memory System fact c."],
        }));
      }
      if (request.jsonSchema?.name === "NarrativeSynthesisOutput") {
        return fakeJsonResponse(JSON.stringify({
          body: [
            "Memory System captures raw observations.",
            "",
            "Memory System fact a.",
            "Memory System fact b.",
            "Memory System fact c.",
          ].join("\n"),
        }));
      }
      if (request.jsonSchema?.name === "FaithfulnessOutput") {
        return fakeJsonResponse(JSON.stringify({ unsupported_claims: [] }));
      }
      throw new Error(`unexpected schema ${request.jsonSchema?.name ?? "none"}`);
    }),
  };
}

function fakeJsonResponse(content: string) {
  return {
    model: "llama3.2",
    finishReason: "stop" as const,
    rawProviderName: "ollama",
    tokensUsed: { prompt: 10, completion: 10, total: 20 },
    content,
  };
}
