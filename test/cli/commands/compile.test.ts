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
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { runCompile } from "../../../src/cli/commands/compile.js";
import type { LLMProvider } from "../../../src/llm/types.js";

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

async function readCompileState(): Promise<{ consumed: Record<string, { bytes: number; lastObservationAt?: string }> }> {
  return JSON.parse(await readFile(join(rootForTest(), "state", "compile-state.json"), "utf-8"));
}

function rootForTest(): string {
  const root = process.env["MEMORY_ROOT"];
  if (!root) throw new Error("MEMORY_ROOT missing in compile test");
  return root;
}
