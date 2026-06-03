import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadEmbeddings,
  saveEmbeddings,
  type EmbeddingRecord,
} from "../../src/retrieval/embeddings-store.js";
import { reblessRedactionOnlyEmbeddings } from "../../src/retrieval/rebless.js";
import { refreshEmbeddings, type EmbedClient } from "../../src/retrieval/refresh.js";
import type { SearchDocument } from "../../src/retrieval/corpus.js";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function doc(relPath: string, body: string): SearchDocument {
  return {
    kind: "wiki",
    relPath,
    fullPath: `C:/vault/${relPath}`,
    title: relPath,
    type: "wiki",
    status: "active",
    confidence: null,
    tags: [],
    relations: {},
    source: "unknown",
    session: null,
    body,
    snippetSource: body,
    updated: null,
    mtime: "2026-06-03T00:00:00.000Z",
    sizeBytes: body.length,
  };
}

function vector(dim: number, primaryIndex: number): number[] {
  const values = Array.from({ length: dim }, () => 0);
  values[primaryIndex] = 1;
  return values;
}

function record(
  relPath: string,
  body: string,
  overrides: Partial<EmbeddingRecord> = {},
): EmbeddingRecord {
  return {
    path: relPath,
    hash: hash(body),
    vector: vector(2048, 0),
    model: "voyage-4-large",
    dim: 2048,
    ts: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("redaction-only embedding rebless", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "embedding-rebless-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes the exact hash refresh uses for a proven redaction-only rewrite", async () => {
    const baselineBody = [
      "Provider setup notes.",
      "VOYAGE_API_KEY=not-a-real-test-value",
      "The retrieval behavior is otherwise unchanged.",
    ].join("\n");
    const currentBody = [
      "Provider setup notes.",
      "VOYAGE_API_KEY=[REDACTED]",
      "The retrieval behavior is otherwise unchanged.",
    ].join("\n");
    const relPath = "wiki/provider.md";
    const originalRecord = record(relPath, baselineBody);
    await saveEmbeddings(tmp, "wiki", [originalRecord], { expectedDim: 2048 });

    const result = await reblessRedactionOnlyEmbeddings({
      memoryRoot: tmp,
      currentDocuments: [doc(relPath, currentBody)],
      baselineDocuments: [doc(relPath, baselineBody)],
      expectedDim: 2048,
      now: () => new Date("2026-06-03T12:00:00.000Z"),
    });
    const reloaded = await loadEmbeddings(tmp, "wiki");
    const reblessedRecord = reloaded.records[0]!;
    const embedClient: EmbedClient = {
      embed: vi.fn(async () => {
        throw new Error("refresh should not re-embed a reblessed record");
      }),
    };
    const refresh = await refreshEmbeddings({
      memoryRoot: tmp,
      documents: [doc(relPath, currentBody)],
      embedClient,
      expectedDim: 2048,
    });

    expect(result).toMatchObject({
      reblessed: 1,
      unchanged: 0,
      errors: [],
    });
    expect(reblessedRecord.vector).toEqual(originalRecord.vector);
    expect(reblessedRecord.hash).not.toBe(originalRecord.hash);
    expect(refresh).toMatchObject({
      embedded: 0,
      unchanged: 1,
      errors: [],
    });
    expect(embedClient.embed).not.toHaveBeenCalled();
  });

  it("refuses to rebless records whose stored vector does not match the configured dimension", async () => {
    const relPath = "wiki/provider.md";
    const baselineBody = "VOYAGE_API_KEY=not-a-real-test-value";
    const currentBody = "VOYAGE_API_KEY=[REDACTED]";
    await saveEmbeddings(tmp, "wiki", [
      record(relPath, baselineBody, {
        vector: [0.25, 0.5, 0.75],
        dim: 3,
      }),
    ]);
    const sidecar = join(tmp, "embeddings", "wiki.embeddings.jsonl");
    const before = await readFile(sidecar, "utf-8");

    const result = await reblessRedactionOnlyEmbeddings({
      memoryRoot: tmp,
      currentDocuments: [doc(relPath, currentBody)],
      baselineDocuments: [doc(relPath, baselineBody)],
      expectedDim: 2048,
    });

    expect(result.reblessed).toBe(0);
    expect(result.errors[0]?.reason).toContain("refusing to rebless");
    await expect(readFile(sidecar, "utf-8")).resolves.toBe(before);
  });
});
