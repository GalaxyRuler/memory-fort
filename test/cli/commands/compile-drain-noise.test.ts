import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompileDrain } from "../../../src/cli/commands/compile.js";
import { readCompileStateFile } from "../../../src/compile/state.js";
import type { LLMProvider } from "../../../src/llm/types.js";

const TEMPLATE = [
  "# memory:custom",
  "RAW={{raw_content}}",
].join("\n");

describe("runCompileDrain noise-only raw handling", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compile-drain-noise-"));
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

  it("counts noise-only watermarks as drain progress and stops on a trailing empty pass", async () => {
    const raws = [
      ["one.md", rawTurn("ToolResult", "dist/assets/one-a1b2c3.js    12.00 kB | gzip: 3.00 kB\n")],
      ["two.md", rawTurn("Log", "Shell cwd was reset to C:\\CodexProjects\\memory-system\n")],
      ["three.md", rawTurn("ToolResult", JSON.stringify({ content: "x".repeat(1_000) }))],
    ] as const;
    for (const [name, body] of raws) {
      await writeFile(join(root, "raw", "2026-06-14", name), body);
    }
    const chat = vi.fn(async () => emptyOpsResponse());

    const result = await runCompileDrain({
      vaultRoot: root,
      execute: true,
      rawFilter: true,
      maxPasses: 5,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM(chat),
      env: {},
    });

    const state = await readCompileStateFile(root);
    expect(result.stopReason).toBe("empty");
    expect(result.passes).toHaveLength(2);
    expect(result.passes[0]?.noiseOnlySkipped).toBe(3);
    expect(result.passes[1]?.noiseOnlySkipped).toBe(0);
    expect(chat).not.toHaveBeenCalled();
    expect(result.quarantinedRawPaths).toEqual([]);
    for (const [name, body] of raws) {
      expect(state.consumed?.[`raw/2026-06-14/${name}`]?.bytes).toBe(Buffer.byteLength(body));
    }
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
