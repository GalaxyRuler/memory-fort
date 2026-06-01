import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { dirname, join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { runCompile, runCompileDrain } from "../../../src/cli/commands/compile.js";
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

  it("advances the watermark after execute and only sends an appended tail on the next run", async () => {
    const rawPath = join(root, "raw", "2026-05-21", "manual-a.md");
    await writeFile(rawPath, "first observation\n");
    const llm = fakeExecuteLLMWith(({ prompt }) => [{
      kind: "write_page",
      path: "wiki/lessons/watermark.md",
      frontmatter: {
        type: "lessons",
        title: "Watermark",
        relations: { derived_from: ["raw/2026-05-21/manual-a.md"] },
      },
      body: prompt.includes("second observation") ? "Second only." : "First only.",
    }]);

    await runCompile({
      vaultRoot: root,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
    });
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

    const statePath = join(root, "state", "compile-state.json");
    const state = existsSync(statePath)
      ? JSON.parse(await readFile(statePath, "utf-8"))
      : {};
    expect(result.execution?.applied).toEqual(["wiki/projects/memory-system.md"]);
    expect(result.rawFilesIncluded).toEqual([rawPath]);
    expect(result.watermarksAdvanced).toEqual([]);
    expect(state.consumed ?? {}).not.toHaveProperty("raw/2026-05-21/manual-a.md");
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
        relations: { derived_from: ["raw/2026-05-21/manual-a.md"] },
      },
      body: `Compile drain body: ${rawSlice}`,
    }];
  });
}

function fakeExecuteLLMWith(
  operations: (opts: { prompt: string }) => unknown[],
): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async (request) => ({
      model: "llama3.2",
      finishReason: "stop",
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
    })),
  };
}

async function writeCompileState(state: Record<string, unknown>): Promise<void> {
  await mkdir(join(rootForTest(), "state"), { recursive: true });
  await writeFile(join(rootForTest(), "state", "compile-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

async function writeFact(relPath: string, fact: Record<string, unknown>): Promise<void> {
  const fullPath = join(rootForTest(), ...relPath.split("/"));
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify({ facts: [fact] }, null, 2)}\n`);
}

async function readCompileState(): Promise<{ consumed: Record<string, { bytes: number; lastObservationAt?: string }> }> {
  return JSON.parse(await readFile(join(rootForTest(), "state", "compile-state.json"), "utf-8"));
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
