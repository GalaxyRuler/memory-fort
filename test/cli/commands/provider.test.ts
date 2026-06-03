import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatListEmbeddersResult,
  formatReindexEmbeddingsResult,
  formatTestEmbedderResult,
  runListEmbedders,
  runReindexEmbeddings,
  runTestEmbedder,
} from "../../../src/cli/commands/provider.js";
import {
  saveEmbeddings,
  type EmbeddingRecord,
} from "../../../src/retrieval/embeddings-store.js";

describe("provider commands", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memory-provider-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("lists embedders with active provider and env names", async () => {
    const result = await runListEmbedders({
      configLoader: async () => ({ embedder: { provider: "ollama", model: "nomic-embed-text" } }),
      env: { OLLAMA_HOST: "http://localhost:11434" },
    });

    expect(formatListEmbeddersResult(result)).toContain("ollama");
    expect(formatListEmbeddersResult(result)).toContain("[active, model=nomic-embed-text, dim=768");
    expect(formatListEmbeddersResult(result)).toContain("VOYAGE_API_KEY");
  });

  it("tests the active embedder and reports latency", async () => {
    const result = await runTestEmbedder({
      configLoader: async () => ({ embedder: { provider: "ollama", model: "nomic-embed-text" } }),
      env: {},
      embedderFactory: () => ({
        providerName: "ollama",
        modelName: "nomic-embed-text",
        dim: 768,
        embed: vi.fn(async () => ({ vectors: [[1, 0]], model: "nomic-embed-text", dim: 2 })),
      }),
      nowMs: (() => {
        const values = [100, 142];
        return () => values.shift() ?? 142;
      })(),
    });

    expect(result.exitCode).toBe(0);
    expect(formatTestEmbedderResult(result)).toContain("Provider: ollama");
    expect(formatTestEmbedderResult(result)).toContain("Latency: 42ms");
    expect(formatTestEmbedderResult(result)).toContain("Status: OK");
  });

  it("plans an embedding reindex without writing embeddings", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "memory.md"),
      "---\ntype: projects\ntitle: Memory\ncreated: 2026-05-27\nupdated: 2026-05-27\n---\nMemory project.\n",
    );
    const result = await runReindexEmbeddings({
      memoryRoot: tmp,
      mode: "plan",
      configLoader: async () => ({ embedder: { provider: "ollama", model: "nomic-embed-text" } }),
      env: {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.applied).toBe(false);
    expect(result.documentCount).toBe(1);
    expect(formatReindexEmbeddingsResult(result)).toContain("Mode: plan");
  });

  it("fails a degenerate embedding reindex without clobbering existing vectors", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "projects", "memory.md"),
      "---\ntype: projects\ntitle: Memory\ncreated: 2026-05-27\nupdated: 2026-05-27\n---\nMemory project.\n",
    );
    await saveEmbeddings(tmp, "wiki", [
      embedding("wiki/projects/memory.md", vector(2048, 0)),
    ], { expectedDim: 2048 });
    const sidecar = join(tmp, "embeddings", "wiki.embeddings.jsonl");
    const before = await readFile(sidecar, "utf-8");

    const result = await runReindexEmbeddings({
      memoryRoot: tmp,
      mode: "apply",
      configLoader: async () => ({ embedder: { provider: "voyage", model: "voyage-4-large" } }),
      env: { VOYAGE_API_KEY: "test-key" },
      embedderFactory: () => ({
        providerName: "voyage",
        modelName: "voyage-4-large",
        dim: 2048,
        embed: vi.fn(async () => ({
          vectors: [[1, 0, 0]],
          model: "voyage-4-large",
          dim: 3,
        })),
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.refresh?.embedded).toBe(0);
    expect(result.refresh?.failedBatches).toBe(1);
    expect(formatReindexEmbeddingsResult(result)).toContain("Failed: 1");
    expect(formatReindexEmbeddingsResult(result)).not.toContain("Errors: 0");
    await expect(readFile(sidecar, "utf-8")).resolves.toBe(before);
  });
});

function embedding(path: string, vector: number[]): EmbeddingRecord {
  return {
    path,
    hash: `hash-${path}`,
    vector,
    model: "voyage-4-large",
    dim: vector.length,
    ts: "2026-06-03T00:00:00.000Z",
  };
}

function vector(dim: number, primaryIndex: number): number[] {
  const values = Array.from({ length: dim }, () => 0);
  values[primaryIndex] = 1;
  return values;
}
