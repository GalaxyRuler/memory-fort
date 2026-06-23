import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompile } from "../../../src/cli/commands/compile.js";
import { readCompileStateFile } from "../../../src/compile/state.js";
import type { LLMProvider } from "../../../src/llm/types.js";

const TEMPLATE = [
  "# memory:custom",
  "RAW={{raw_content}}",
].join("\n");

describe("runCompile noise-only raw skip", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compile-noise-skip-"));
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "raw", "2026-06-14"), { recursive: true });
    await mkdir(join(root, "wiki"), { recursive: true });
    await writeFile(join(root, "prompts", "compile.md"), TEMPLATE);
    await writeFile(join(root, "schema.md"), "# Schema\n");
    await writeFile(join(root, "index.md"), "# Index\n");
    await writeFile(join(root, "log.md"), "# Log\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("skips the LLM for all-noise slices and advances their watermark", async () => {
    const rawPath = join(root, "raw", "2026-06-14", "noise.md");
    const raw = rawTurn("ToolResult", [
      "\u001b[32m✓ built in 812ms\u001b[39m",
      "dist/assets/index-a1b2c3.js    128.44 kB │ gzip: 42.10 kB",
      JSON.stringify({ content: "x".repeat(2_000) }),
    ].join("\n"));
    await writeFile(rawPath, raw);
    const chat = vi.fn(async () => emptyOpsResponse());

    const result = await runCompile({
      vaultRoot: root,
      rawFilter: true,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM(chat),
      env: {},
    });

    const state = await readCompileStateFile(root);
    expect(chat).not.toHaveBeenCalled();
    expect(result.noiseOnlySkipped).toBe(1);
    expect(state.consumed?.["raw/2026-06-14/noise.md"]?.bytes).toBe(Buffer.byteLength(raw));
  });

  it("skips the LLM for a codex suggestion-generator session and advances its watermark", async () => {
    await mkdir(join(root, "raw", "2026-06-20"), { recursive: true });
    const rawPath = join(root, "raw", "2026-06-20", "codex-suggest.md");
    const raw =
      "---\ntype: raw-session\nsource: codex\n---\n\n" +
      rawTurn("Prompt", "# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: C:\\X\n\n# Rules\n[]");
    await writeFile(rawPath, raw);
    const chat = vi.fn(async () => emptyOpsResponse());

    const result = await runCompile({
      vaultRoot: root,
      rawFilter: true,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM(chat),
      env: {},
    });

    const state = await readCompileStateFile(root);
    expect(chat).not.toHaveBeenCalled();
    expect(result.noiseOnlySkipped).toBe(1);
    expect(state.consumed?.["raw/2026-06-20/codex-suggest.md"]?.bytes).toBe(Buffer.byteLength(raw));
  });

  it("sends a capped slice when a keep-list error line is present", async () => {
    const rawPath = join(root, "raw", "2026-06-14", "signal.md");
    await writeFile(rawPath, rawTurn("ToolResult", [
      "dist/assets/index-a1b2c3.js    128.44 kB │ gzip: 42.10 kB",
      "error: unknown option '--kill'",
    ].join("\n")));
    const chat = vi.fn(async () => emptyOpsResponse());

    const result = await runCompile({
      vaultRoot: root,
      rawFilter: true,
      execute: true,
      perFileMaxBytes: 160,
      totalMaxBytes: 160,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM(chat),
      env: {},
    });

    expect(result.noiseOnlySkipped).toBe(0);
    expect(result.rawFilesIncluded).toEqual([rawPath]);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("does not corrupt multibyte UTF-8 when the byte cap lands inside a character", async () => {
    const arabic = "اختبار الذاكرة";
    await writeFile(join(root, "raw", "2026-06-14", "arabic.md"), rawTurn("Prompt", arabic.repeat(20)));

    const result = await runCompile({
      vaultRoot: root,
      rawFilter: true,
      perFileMaxBytes: Buffer.byteLength("## [12:00:00] Prompt\n\n", "utf-8") + 5,
      totalMaxBytes: Buffer.byteLength("## [12:00:00] Prompt\n\n", "utf-8") + 5,
    });

    expect(result.prompt).not.toContain("\uFFFD");
  });

  it("advances a noise-only partial slice only to raw.cursor", async () => {
    const first = rawTurn("ToolResult", "dist/assets/one.js    12.00 kB │ gzip: 3.00 kB");
    const second = rawTurn("ToolResult", "dist/assets/two.js    14.00 kB │ gzip: 4.00 kB");
    await writeFile(join(root, "raw", "2026-06-14", "partial.md"), first + second);
    const chat = vi.fn(async () => emptyOpsResponse());

    await runCompile({
      vaultRoot: root,
      rawFilter: true,
      execute: true,
      perFileMaxBytes: Buffer.byteLength(first),
      totalMaxBytes: Buffer.byteLength(first),
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM(chat),
      env: {},
    });

    const state = await readCompileStateFile(root);
    expect(state.consumed?.["raw/2026-06-14/partial.md"]?.bytes).toBe(Buffer.byteLength(first));
  });
});

function rawTurn(kind: string, body: string): string {
  return `## [12:00:00] ${kind}\n\n${body}\n`;
}

function fakeLLM(chat: LLMProvider["chat"]): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat,
  };
}

function emptyOpsResponse() {
  return {
    model: "llama3.2",
    finishReason: "stop" as const,
    rawProviderName: "ollama",
    content: "```compile-ops\n{\"operations\":[]}\n```",
  };
}
