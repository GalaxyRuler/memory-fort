import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompile, runCompileDrain } from "../../../src/cli/commands/compile.js";
import { compileStatePath, readCompileStateFile } from "../../../src/compile/state.js";
import type { LLMProvider } from "../../../src/llm/types.js";

const TEMPLATE = [
  "# memory:custom",
  "RAW={{raw_content}}",
].join("\n");

describe("runCompile low-signal raw quarantine", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compile-quarantine-lowsignal-"));
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "raw", "2026-06-20"), { recursive: true });
    await mkdir(join(root, "wiki"), { recursive: true });
    await writeFile(join(root, "prompts", "compile.md"), TEMPLATE);
    await writeFile(join(root, "schema.md"), "# Schema\n");
    await writeFile(join(root, "index.md"), "# Index\n");
    await writeFile(join(root, "log.md"), "# Log\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("quarantines low-signal raw sessions when the opt-in filter is enabled", async () => {
    const relPath = "raw/2026-06-20/tiny.md";
    const rawPath = join(root, "raw", "2026-06-20", "tiny.md");
    const raw = rawTurn("Prompt", "hi");
    await writeFile(rawPath, raw);
    const chat = vi.fn(async () => emptyOpsResponse());

    const result = await runCompile({
      vaultRoot: root,
      rawFilter: true,
      execute: true,
      configLoader: async () => ({
        compile: {
          raw_filter_quarantine_low_signal: true,
          raw_filter_min_signal_bytes: 40,
        },
        llm: { provider: "ollama", model: "llama3.2" },
      }),
      llmFactory: () => fakeLLM(chat),
      env: {},
    });

    const state = await readCompileStateFile(root);
    const quarantineLog = await readFile(join(root, "var", "quarantine-lowsignal.jsonl"), "utf-8");
    const quarantineEntries = quarantineLog.trim().split("\n").map((line) => JSON.parse(line) as {
      relPath?: unknown;
      signalBytes?: unknown;
      at?: unknown;
    });
    expect(chat).not.toHaveBeenCalled();
    expect(result.lowSignalQuarantined).toBe(1);
    expect(state.consumed?.[relPath]?.bytes).toBe(Buffer.byteLength(raw));
    expect(quarantineEntries).toHaveLength(1);
    expect(quarantineEntries[0]).toEqual({
      relPath,
      signalBytes: expect.any(Number),
      at: expect.any(String),
    });
  });

  it("does not commit low-signal quarantine during filter reports", async () => {
    const rawPath = join(root, "raw", "2026-06-20", "tiny.md");
    await writeFile(rawPath, rawTurn("Prompt", "hi"));

    const result = await runCompile({
      vaultRoot: root,
      filterReport: true,
      configLoader: async () => ({
        compile: {
          raw_filter_quarantine_low_signal: true,
          raw_filter_min_signal_bytes: 40,
        },
      }),
    });

    expect(result.lowSignalQuarantined).toBe(0);
    expect(existsSync(join(root, "var", "quarantine-lowsignal.jsonl"))).toBe(false);
    expect(existsSync(compileStatePath(root))).toBe(false);
  });

  it("does not commit low-signal quarantine or consume watermarks in plan mode", async () => {
    const relPath = "raw/2026-06-20/tiny.md";
    const rawPath = join(root, "raw", "2026-06-20", "tiny.md");
    await writeFile(rawPath, rawTurn("Prompt", "hi"));

    const result = await runCompile({
      vaultRoot: root,
      rawFilter: true,
      plan: true,
      execute: true,
      configLoader: async () => ({
        compile: {
          raw_filter_quarantine_low_signal: true,
          raw_filter_min_signal_bytes: 40,
        },
        llm: { provider: "ollama", model: "llama3.2" },
      }),
      llmFactory: () => fakeLLM(vi.fn(async () => emptyOpsResponse())),
      env: {},
    });

    const state = await readCompileStateFile(root);
    expect(result.lowSignalQuarantined).toBe(0);
    expect(result.watermarksAdvanced).not.toContain(relPath);
    expect(state.consumed ?? {}).not.toHaveProperty(relPath);
    expect(existsSync(join(root, "var", "quarantine-lowsignal.jsonl"))).toBe(false);
  });

  it("sends low-signal raw sessions to the LLM by default", async () => {
    const rawPath = join(root, "raw", "2026-06-20", "tiny.md");
    const raw = rawTurn("Prompt", "hi");
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

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.lowSignalQuarantined).toBe(0);
  });

  it("drain continues past a low-signal-only pass while backlog remains", async () => {
    // Two low-signal raws + one file per pass: pass 1 quarantines only one and
    // defers the other. A low-signal-only pass has rawFilesIncluded=0 and
    // noiseOnlySkipped=0, so the drain empty-check must also consider
    // lowSignalQuarantined or it stops early and never reaches the second file.
    await writeFile(join(root, "raw", "2026-06-20", "a-tiny.md"), rawTurn("Prompt", "hi"));
    await writeFile(join(root, "raw", "2026-06-20", "b-tiny.md"), rawTurn("Prompt", "yo"));
    const chat = vi.fn(async () => emptyOpsResponse());

    const result = await runCompileDrain({
      vaultRoot: root,
      execute: true,
      rawFilter: true,
      maxFilesPerPass: 1,
      maxPasses: 5,
      configLoader: async () => ({
        compile: {
          raw_filter_quarantine_low_signal: true,
          raw_filter_min_signal_bytes: 40,
        },
        llm: { provider: "ollama", model: "llama3.2" },
      }),
      llmFactory: () => fakeLLM(chat),
      env: {},
    });

    const state = await readCompileStateFile(root);
    const quarantineLog = await readFile(join(root, "var", "quarantine-lowsignal.jsonl"), "utf-8");
    const entries = quarantineLog.trim().split("\n").filter(Boolean);
    expect(chat).not.toHaveBeenCalled();
    expect(entries).toHaveLength(2);
    expect(result.passes.reduce((sum, pass) => sum + pass.lowSignalQuarantined, 0)).toBe(2);
    expect(state.consumed?.["raw/2026-06-20/a-tiny.md"]?.bytes).toBeGreaterThan(0);
    expect(state.consumed?.["raw/2026-06-20/b-tiny.md"]?.bytes).toBeGreaterThan(0);
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
