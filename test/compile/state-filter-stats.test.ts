import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompile } from "../../src/cli/commands/compile.js";
import { readCompileStateFile } from "../../src/compile/state.js";

const TEMPLATE = [
  "# memory:custom",
  "RAW={{raw_content}}",
].join("\n");

describe("compile state filter stats", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compile-state-filter-stats-"));
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

  it("persists lastFilterStats after a filtered compile run", async () => {
    const raw = rawTurn("ToolResult", [
      "dist/assets/index-a1b2c3.js    128.44 kB | gzip: 42.10 kB",
      JSON.stringify({ content: "x".repeat(1_000) }),
    ].join("\n"));
    await writeFile(join(root, "raw", "2026-06-14", "noise.md"), raw);

    const result = await runCompile({
      vaultRoot: root,
      rawFilter: true,
      execute: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => ({
        providerName: "ollama",
        modelName: "llama3.2",
        chat: async () => {
          throw new Error("noise-only run must not call the LLM");
        },
      }),
      env: {},
    });

    const state = await readCompileStateFile(root);
    expect(state.lastFilterStats).toEqual(expect.objectContaining({
      bytesIn: result.filterStats?.bytesIn,
      bytesOut: result.filterStats?.bytesOut,
      rawBytesConsumed: Buffer.byteLength(raw),
      strippedByClass: result.filterStats?.strippedByClass,
    }));
    expect(state.lastFilterStats?.bytesIn).toBeGreaterThan(state.lastFilterStats?.bytesOut ?? 0);
    expect(state.lastFilterStats?.strippedByClass["base64-blob"]).toBeGreaterThan(0);
    expect(state.lastFilterStats?.runId).toEqual(expect.any(String));
    expect(state.lastFilterStats?.at).toEqual(expect.any(String));
    expect(new Date(state.lastFilterStats?.at ?? Number.NaN).toString()).not.toBe("Invalid Date");
  });
});

function rawTurn(kind: string, body: string): string {
  return `## [12:00:00] ${kind}\n\n${body}\n`;
}
