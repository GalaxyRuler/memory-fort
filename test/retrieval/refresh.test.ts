import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEmbeddings,
  saveEmbeddings,
  type EmbeddingRecord,
} from "../../src/retrieval/embeddings-store.js";
import { refreshEmbeddings, type EmbedClient } from "../../src/retrieval/refresh.js";
import type { SearchDocument } from "../../src/retrieval/corpus.js";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function doc(relPath: string, body: string, kind: SearchDocument["kind"] = "wiki"): SearchDocument {
  return {
    kind,
    relPath,
    fullPath: `C:/vault/${relPath}`,
    title: relPath,
    type: kind === "raw" ? "raw-session" : kind,
    status: "active",
    confidence: null,
    tags: [],
    relations: {},
    source: "unknown",
    session: null,
    body,
    snippetSource: body,
    updated: null,
    mtime: "2026-05-23T00:00:00.000Z",
    sizeBytes: body.length,
  };
}

function embeddingRecord(
  searchDoc: SearchDocument,
  overrides: Partial<EmbeddingRecord> = {},
): EmbeddingRecord {
  return {
    path: searchDoc.relPath,
    hash: hash(searchDoc.body),
    vector: [1, 2, 3],
    model: "voyage-4-large",
    dim: 2048,
    ts: "2026-05-23T00:00:00.000Z",
    ...overrides,
  };
}

function fakeClient(vectors: number[][], model = "voyage-4-large", dim = 2048): EmbedClient {
  return {
    embed: vi.fn(async () => ({ vectors, model, dim })),
  };
}

function capturingClient(): EmbedClient & { embed: ReturnType<typeof vi.fn> } {
  const embed = vi.fn(async (texts: string[]) => ({
    vectors: texts.map(() => [1, 2, 3]),
    model: "voyage-4-large",
    dim: 2048,
  }));
  return { embed } as EmbedClient & { embed: ReturnType<typeof vi.fn> };
}

describe("embedding refresh", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "embeddings-refresh-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("First refresh against an empty store embeds all docs", async () => {
    const documents = [
      doc("wiki/a.md", "A"),
      doc("wiki/b.md", "B"),
      doc("wiki/c.md", "C"),
    ];
    const embedClient = fakeClient([[1], [2], [3]]);

    const result = await refreshEmbeddings({
      memoryRoot: tmp,
      documents,
      embedClient,
      now: () => new Date("2026-05-23T00:00:00.000Z"),
    });

    expect(result).toEqual({
      embedded: 3,
      unchanged: 0,
      pruned: 0,
      errors: [],
      totalRecords: 3,
    });
    expect(embedClient.embed).toHaveBeenCalledOnce();
    expect(embedClient.embed).toHaveBeenCalledWith(["A", "B", "C"]);
  });

  it("Second refresh with identical content embeds zero docs", async () => {
    const documents = [
      doc("wiki/a.md", "A"),
      doc("wiki/b.md", "B"),
      doc("wiki/c.md", "C"),
    ];
    await saveEmbeddings(tmp, "wiki", documents.map((item) => embeddingRecord(item)));
    const embedClient = fakeClient([]);

    const result = await refreshEmbeddings({ memoryRoot: tmp, documents, embedClient });

    expect(result).toEqual({
      embedded: 0,
      unchanged: 3,
      pruned: 0,
      errors: [],
      totalRecords: 3,
    });
    expect(embedClient.embed).not.toHaveBeenCalled();
  });

  it("Modified document re-embeds", async () => {
    const original = [
      doc("wiki/a.md", "A"),
      doc("wiki/b.md", "B"),
      doc("wiki/c.md", "C"),
    ];
    await saveEmbeddings(tmp, "wiki", original.map((item) => embeddingRecord(item)));
    const documents = [original[0]!, doc("wiki/b.md", "B changed"), original[2]!];
    const embedClient = fakeClient([[9]]);

    const result = await refreshEmbeddings({ memoryRoot: tmp, documents, embedClient });

    expect(result).toEqual({
      embedded: 1,
      unchanged: 2,
      pruned: 0,
      errors: [],
      totalRecords: 3,
    });
  });

  it("Removed document prunes its record", async () => {
    const documents = [
      doc("wiki/a.md", "A"),
      doc("wiki/b.md", "B"),
      doc("wiki/c.md", "C"),
    ];
    await saveEmbeddings(tmp, "wiki", documents.map((item) => embeddingRecord(item)));
    const embedClient = fakeClient([]);

    const result = await refreshEmbeddings({
      memoryRoot: tmp,
      documents: [documents[0]!, documents[1]!],
      embedClient,
    });
    const reloaded = await loadEmbeddings(tmp, "wiki");

    expect(result).toEqual({
      embedded: 0,
      unchanged: 2,
      pruned: 1,
      errors: [],
      totalRecords: 2,
    });
    expect(reloaded.records.map((item) => item.path)).not.toContain("wiki/c.md");
  });

  it("Model/dim mismatch triggers re-embed", async () => {
    const document = doc("wiki/a.md", "A");
    await saveEmbeddings(tmp, "wiki", [
      embeddingRecord(document, { model: "voyage-3.5", dim: 1024 }),
    ]);
    const embedClient = fakeClient([[8, 8]], "voyage-4-large", 2048);

    const result = await refreshEmbeddings({
      memoryRoot: tmp,
      documents: [document],
      embedClient,
    });

    expect(result).toMatchObject({
      embedded: 1,
      unchanged: 0,
      pruned: 0,
      errors: [],
    });
  });

  it("Embed timeout produces an error entry without throwing", async () => {
    const document = doc("wiki/a.md", "A");
    const before = embeddingRecord(document);
    await saveEmbeddings(tmp, "wiki", [before]);
    const embedClient: EmbedClient = {
      embed: vi.fn(() => new Promise(() => undefined)),
    };

    const result = await refreshEmbeddings({
      memoryRoot: tmp,
      documents: [doc("wiki/a.md", "changed")],
      embedClient,
      timeoutMs: 100,
    });
    const reloaded = await loadEmbeddings(tmp, "wiki");

    expect(result.embedded).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reason.toLowerCase()).toContain("timeout");
    expect(reloaded.records).toEqual([before]);
  });

  it("Per-doc truncation keeps oversized raws under the Voyage item limit", async () => {
    const embedClient = capturingClient();
    const longBody = "word ".repeat(40_000);

    const result = await refreshEmbeddings({
      memoryRoot: tmp,
      documents: [doc("raw/2026-05-23/codex-large.md", longBody, "raw")],
      embedClient,
    });

    const firstCallTexts = embedClient.embed.mock.calls[0]?.[0] as string[];
    expect(result.embedded).toBe(1);
    expect(firstCallTexts[0]!.length).toBeLessThanOrEqual(120_000);
  });

  it("Token-aware batching splits batches before cumulative Voyage token cap", async () => {
    const embedClient = capturingClient();
    const documents = Array.from({ length: 10 }, (_, index) =>
      doc(`raw/2026-05-23/codex-${index}.md`, "x".repeat(50_000), "raw"),
    );

    const result = await refreshEmbeddings({
      memoryRoot: tmp,
      documents,
      embedClient,
    });

    expect(result.embedded).toBe(10);
    expect(embedClient.embed).toHaveBeenCalledTimes(2);
  });

  it("Single doc near per-doc limit embeds in one batch", async () => {
    const embedClient = capturingClient();
    const nearLimitBody = "x".repeat(120_000);

    const result = await refreshEmbeddings({
      memoryRoot: tmp,
      documents: [doc("raw/2026-05-23/codex-near-limit.md", nearLimitBody, "raw")],
      embedClient,
    });

    const firstCallTexts = embedClient.embed.mock.calls[0]?.[0] as string[];
    expect(result.embedded).toBe(1);
    expect(embedClient.embed).toHaveBeenCalledOnce();
    expect(firstCallTexts[0]).toHaveLength(120_000);
  });
});
