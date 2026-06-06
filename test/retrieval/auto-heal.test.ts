import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readAutoHealStatus,
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
      configLoader: async () => ({
        auto_heal: { enabled: true, capture_debounce_seconds: 0 },
        embedder: { provider: "voyage", model: "voyage-4-large" },
      }),
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
      configLoader: async () => ({
        auto_heal: { enabled: true, capture_debounce_seconds: 0 },
        embedder: { provider: "voyage", model: "voyage-4-large" },
      }),
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
      configLoader: async () => ({
        auto_heal: { enabled: true, daily_budget_usd: 0, capture_debounce_seconds: 0 },
        embedder: { provider: "voyage", model: "voyage-4-large" },
      }),
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

  it("uses today's auto-heal log spend as status truth", async () => {
    await mkdir(join(tmp, "embeddings"), { recursive: true });
    await writeFile(
      join(tmp, "embeddings", "auto-heal-status.json"),
      JSON.stringify({
        day: "2026-06-04",
        dailySpendUsd: 0.001,
        lastTick: "2026-06-04T09:00:00.000Z",
        lastEmbed: "2026-06-04T09:00:00.000Z",
      }),
    );
    await writeFile(
      join(tmp, "embeddings", "auto-heal.jsonl"),
      [
        JSON.stringify({ ts: "2026-06-03T23:59:59.000Z", source: "capture-time", path: "raw/old.md", tokens: 1, cost_usd: 0.5, outcome: "embedded" }),
        JSON.stringify({ ts: "2026-06-04T00:01:00.000Z", source: "capture-time", path: "raw/today-a.md", tokens: 1, cost_usd: 0.002, outcome: "embedded" }),
        JSON.stringify({ ts: "2026-06-04T00:02:00.000Z", source: "capture-time", path: "raw/today-b.md", tokens: 1, cost_usd: 0, outcome: "failed" }),
        JSON.stringify({ ts: "2026-06-04T00:03:00.000Z", source: "reconciler", path: "raw/today-c.md", tokens: 1, cost_usd: 0.003, outcome: "embedded" }),
        JSON.stringify({ ts: "2026-06-05T00:00:00.000Z", source: "capture-time", path: "raw/tomorrow.md", tokens: 1, cost_usd: 0.7, outcome: "embedded" }),
        "",
      ].join("\n"),
    );

    const status = await readAutoHealStatus(tmp, {
      configLoader: async () => ({ auto_heal: { enabled: true, daily_budget_usd: 0.5 } }),
      now: () => now,
    });

    expect(status.dailySpendUsd).toBeCloseTo(0.005, 12);
  });

  it("uses log-derived spend for the daily budget gate", async () => {
    await writeRaw("raw/2026-06-04/codex-new.md", "Budgeted raw body.");
    await mkdir(join(tmp, "embeddings"), { recursive: true });
    await writeFile(
      join(tmp, "embeddings", "auto-heal-status.json"),
      JSON.stringify({ day: "2026-06-04", dailySpendUsd: 0, lastTick: null, lastEmbed: null }),
    );
    await writeFile(
      join(tmp, "embeddings", "auto-heal.jsonl"),
      `${JSON.stringify({ ts: "2026-06-04T09:00:00.000Z", source: "capture-time", path: "raw/already.md", tokens: 1, cost_usd: 0.02, outcome: "embedded" })}\n`,
    );
    const embed = vi.fn();
    const logs: unknown[] = [];

    const result = await runAutoHealCapture({
      memoryRoot: tmp,
      relPath: "raw/2026-06-04/codex-new.md",
      configLoader: async () => ({
        auto_heal: { enabled: true, daily_budget_usd: 0.020001, capture_debounce_seconds: 0 },
        embedder: { provider: "voyage", model: "voyage-4-large" },
      }),
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

  it("debounces capture-time embeds for a growing raw and embeds the final body once", async () => {
    let currentNow = new Date("2026-06-04T10:00:00.000Z");
    const capturedTexts: string[] = [];
    const embed = vi.fn(async (request: { texts: string[] }) => {
      capturedTexts.push(...request.texts);
      return {
        vectors: request.texts.map(() => vector(2048, 4)),
        model: "voyage-4-large",
        dim: 2048,
        inputTokens: 12,
      };
    });

    for (let index = 0; index < 5; index += 1) {
      await writeRaw("raw/2026-06-04/codex-growing.md", `Growing body ${index}`);
      const result = await runAutoHealCapture({
        memoryRoot: tmp,
        relPath: "raw/2026-06-04/codex-growing.md",
        configLoader: async () => ({
          auto_heal: { enabled: true, capture_debounce_seconds: 30 },
          embedder: { provider: "voyage", model: "voyage-4-large" },
        }),
        env: { VOYAGE_API_KEY: "test-key" },
        embedderFactory: () => ({
          providerName: "voyage",
          modelName: "voyage-4-large",
          dim: 2048,
          embed,
        }),
        now: () => currentNow,
      });

      expect(result.embedded).toBe(0);
      currentNow = new Date(currentNow.getTime() + 5_000);
    }

    currentNow = new Date(currentNow.getTime() + 31_000);
    const tick = await runAutoHealTick({
      memoryRoot: tmp,
      configLoader: async () => ({
        auto_heal: { enabled: true, capture_debounce_seconds: 30 },
        embedder: { provider: "voyage", model: "voyage-4-large" },
      }),
      env: { VOYAGE_API_KEY: "test-key" },
      embedderFactory: () => ({
        providerName: "voyage",
        modelName: "voyage-4-large",
        dim: 2048,
        embed,
      }),
      now: () => currentNow,
    });

    expect(tick.embedded).toBe(1);
    expect(embed).toHaveBeenCalledOnce();
    expect(capturedTexts[0]).toContain("Growing body 4");
    expect(capturedTexts[0]).not.toContain("Growing body 0");
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
