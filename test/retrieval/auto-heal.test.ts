import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runAutoHealCapture,
  runAutoHealTick,
} from "../../src/retrieval/auto-heal.js";
import {
  loadEmbeddings,
  saveEmbeddings,
  type EmbeddingRecord,
} from "../../src/retrieval/embeddings-store.js";

describe("auto-heal embeddings", () => {
  let tmp: string;
  const now = new Date("2026-06-04T10:00:00.000Z");

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "auto-heal-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("capture-time embeds one new raw without pruning existing raw sidecar records", async () => {
    await writeRaw("raw/2026-06-04/codex-new.md", "New raw body for auto heal.");
    const existing = embedding("raw/2026-06-03/codex-old.md", "old hash");
    await saveEmbeddings(tmp, "raw", [existing], { expectedDim: 2048 });
    const logs: unknown[] = [];
    const embed = vi.fn(async (request: { texts: string[] }) => ({
      vectors: request.texts.map(() => vector(2048, 3)),
      model: "voyage-4-large",
      dim: 2048,
      inputTokens: 12,
    }));

    const result = await runAutoHealCapture({
      memoryRoot: tmp,
      relPath: "raw/2026-06-04/codex-new.md",
      configLoader: async () => ({ auto_heal: { enabled: true }, embedder: { provider: "voyage", model: "voyage-4-large" } }),
      env: { VOYAGE_API_KEY: "test-key" },
      embedderFactory: () => ({
        providerName: "voyage",
        modelName: "voyage-4-large",
        dim: 2048,
        embed,
      }),
      logWriter: async (entry) => {
        logs.push(entry);
      },
      now: () => now,
    });

    const loaded = await loadEmbeddings(tmp, "raw");
    expect(result.embedded).toBe(1);
    expect(embed).toHaveBeenCalledOnce();
    expect(loaded.records.map((record) => record.path).sort()).toEqual([
      "raw/2026-06-03/codex-old.md",
      "raw/2026-06-04/codex-new.md",
    ]);
    expect(logs).toContainEqual(expect.objectContaining({
      source: "capture-time",
      path: "raw/2026-06-04/codex-new.md",
      outcome: "embedded",
      tokens: 12,
    }));
  });

  it("fails soft and writes no sidecar when the active provider key is missing", async () => {
    await writeRaw("raw/2026-06-04/codex-new.md", "New raw body.");
    const logs: unknown[] = [];

    const result = await runAutoHealCapture({
      memoryRoot: tmp,
      relPath: "raw/2026-06-04/codex-new.md",
      configLoader: async () => ({ auto_heal: { enabled: true }, embedder: { provider: "voyage", model: "voyage-4-large" } }),
      env: {},
      logWriter: async (entry) => {
        logs.push(entry);
      },
      now: () => now,
    });

    const loaded = await loadEmbeddings(tmp, "raw");
    expect(result.embedded).toBe(0);
    expect(result.errors[0]?.reason).toContain("VOYAGE_API_KEY");
    expect(loaded.records).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({
      source: "capture-time",
      path: "raw/2026-06-04/codex-new.md",
      outcome: "skipped",
    }));
  });

  it("respects the daily budget before calling the embedder", async () => {
    await writeRaw("raw/2026-06-04/codex-new.md", "Budgeted raw body.");
    const embed = vi.fn();
    const logs: unknown[] = [];

    const result = await runAutoHealCapture({
      memoryRoot: tmp,
      relPath: "raw/2026-06-04/codex-new.md",
      configLoader: async () => ({ auto_heal: { enabled: true, daily_budget_usd: 0 }, embedder: { provider: "voyage", model: "voyage-4-large" } }),
      env: { VOYAGE_API_KEY: "test-key" },
      embedderFactory: () => ({
        providerName: "voyage",
        modelName: "voyage-4-large",
        dim: 2048,
        embed,
      }),
      logWriter: async (entry) => {
        logs.push(entry);
      },
      now: () => now,
    });

    expect(result.embedded).toBe(0);
    expect(result.skippedBudget).toBe(1);
    expect(embed).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({
      outcome: "skipped",
      reason: "daily budget reached",
    }));
  });

  it("reconciler embeds missed docs with a per-tick document cap", async () => {
    await writeRaw("raw/2026-06-04/codex-a.md", "A raw body.");
    await writeRaw("raw/2026-06-04/codex-b.md", "B raw body.");
    const embed = vi.fn(async (request: { texts: string[] }) => ({
      vectors: request.texts.map((_, index) => vector(2048, index + 1)),
      model: "voyage-4-large",
      dim: 2048,
      inputTokens: 8,
    }));

    const result = await runAutoHealTick({
      memoryRoot: tmp,
      configLoader: async () => ({
        auto_heal: { enabled: true, max_docs_per_tick: 1 },
        embedder: { provider: "voyage", model: "voyage-4-large" },
      }),
      env: { VOYAGE_API_KEY: "test-key" },
      embedderFactory: () => ({
        providerName: "voyage",
        modelName: "voyage-4-large",
        dim: 2048,
        embed,
      }),
      now: () => now,
    });

    const loaded = await loadEmbeddings(tmp, "raw");
    expect(result.embedded).toBe(1);
    expect(result.skippedPending).toBe(1);
    expect(embed).toHaveBeenCalledOnce();
    expect(loaded.records).toHaveLength(1);
  });

  async function writeRaw(relPath: string, body: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(
      fullPath,
      [
        "---",
        "type: raw-session",
        "title: Raw",
        "created: 2026-06-04",
        "updated: 2026-06-04",
        "source: codex",
        "session: test",
        "---",
        "",
        body,
        "",
      ].join("\n"),
    );
  }
});

function embedding(path: string, hash: string): EmbeddingRecord {
  return {
    path,
    hash,
    vector: vector(2048, 0),
    model: "voyage-4-large",
    dim: 2048,
    ts: "2026-06-04T00:00:00.000Z",
  };
}

function vector(dim: number, primaryIndex: number): number[] {
  const values = Array.from({ length: dim }, () => 0);
  values[primaryIndex] = 1;
  return values;
}
