import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEmbeddings,
  loadEmbeddingsMeta,
  removeStale,
  saveEmbeddings,
  saveEmbeddingsMeta,
  type EmbeddingRecord,
  type EmbeddingsMeta,
} from "../../src/retrieval/embeddings-store.js";

function record(
  path: string,
  ts = "2026-05-23T00:00:00.000Z",
  overrides: Partial<EmbeddingRecord> = {},
): EmbeddingRecord {
  return {
    path,
    hash: `hash-${path}`,
    vector: [1, 2, 3],
    model: "voyage-4-large",
    dim: 3,
    ts,
    ...overrides,
  };
}

function vector(dim: number, primaryIndex: number): number[] {
  const values = Array.from({ length: dim }, () => 0);
  values[primaryIndex] = 1;
  return values;
}

describe("embeddings sidecar store", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "embeddings-store-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("loadEmbeddings returns empty when JSONL file is missing", async () => {
    await expect(loadEmbeddings(tmp, "wiki")).resolves.toEqual({
      records: [],
      warnings: [],
    });
  });

  it("saveEmbeddings writes records line-by-line and loadEmbeddings round-trips", async () => {
    const records = [
      record("wiki/a.md"),
      record("wiki/b.md"),
      record("wiki/c.md"),
    ];

    await saveEmbeddings(tmp, "wiki", records);

    await expect(loadEmbeddings(tmp, "wiki")).resolves.toEqual({
      records,
      warnings: [],
    });
  });

  it("saveEmbeddings refuses wrong-dimension records and leaves existing sidecar intact", async () => {
    const existing = record("wiki/existing.md", "2026-05-23T00:00:00.000Z", {
      vector: vector(2048, 0),
      dim: 2048,
    });
    await saveEmbeddings(tmp, "wiki", [existing], { expectedDim: 2048 });
    const path = join(tmp, "embeddings", "wiki.embeddings.jsonl");
    const before = await readFile(path, "utf-8");

    await expect(
      saveEmbeddings(tmp, "wiki", [
        record("wiki/stub.md", "2026-05-23T00:00:00.000Z", {
          vector: [1, 0, 0],
          dim: 3,
        }),
      ], { expectedDim: 2048 }),
    ).rejects.toThrow(/refusing to write degenerate embeddings/);

    await expect(readFile(path, "utf-8")).resolves.toBe(before);
  });

  it("loadEmbeddings skips malformed lines and reports warnings", async () => {
    await mkdir(join(tmp, "embeddings"), { recursive: true });
    await writeFile(
      join(tmp, "embeddings", "wiki.embeddings.jsonl"),
      [
        JSON.stringify(record("wiki/a.md")),
        "{not json",
        JSON.stringify({ path: "wiki/missing-fields.md" }),
        JSON.stringify(record("wiki/b.md")),
      ].join("\n"),
    );

    const result = await loadEmbeddings(tmp, "wiki");

    expect(result.records).toHaveLength(2);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatchObject({ line: 2 });
    expect(result.warnings[0]?.reason).toEqual(expect.any(String));
    expect(result.warnings[1]).toMatchObject({ line: 3 });
    expect(result.warnings[1]?.reason).toEqual(expect.any(String));
  });

  it("loadEmbeddings dedupes duplicate paths, keeping the newest ts", async () => {
    const older = record("wiki/foo.md", "2026-05-22T00:00:00.000Z");
    const newer = {
      ...record("wiki/foo.md", "2026-05-23T00:00:00.000Z"),
      vector: [9, 9, 9],
    };
    await mkdir(join(tmp, "embeddings"), { recursive: true });
    await writeFile(
      join(tmp, "embeddings", "wiki.embeddings.jsonl"),
      [older, newer, record("wiki/bar.md")].map(JSON.stringify).join("\n"),
    );

    const result = await loadEmbeddings(tmp, "wiki");

    expect(result.records).toHaveLength(2);
    expect(result.records.find((item) => item.path === "wiki/foo.md")).toEqual(
      newer,
    );
  });

  it("removeStale rewrites the JSONL with only records whose path is in knownPaths", async () => {
    await saveEmbeddings(tmp, "wiki", [
      record("wiki/a.md"),
      record("wiki/b.md"),
      record("wiki/c.md"),
      record("wiki/d.md"),
      record("wiki/e.md"),
    ]);

    const result = await removeStale(
      tmp,
      "wiki",
      new Set(["wiki/a.md", "wiki/c.md"]),
    );
    const reloaded = await loadEmbeddings(tmp, "wiki");

    expect(result).toEqual({ removed: 3 });
    expect(reloaded.records.map((item) => item.path)).toEqual([
      "wiki/a.md",
      "wiki/c.md",
    ]);
  });

  it("saveEmbeddingsMeta + loadEmbeddingsMeta round-trip; missing file returns null", async () => {
    const meta: EmbeddingsMeta = {
      provider: "voyage",
      model: "voyage-4-large",
      dim: 2048,
      sdkVersion: "0.2.1",
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T01:00:00.000Z",
    };
    const otherTmp = await mkdtemp(join(tmpdir(), "embeddings-meta-empty-"));

    try {
      await expect(loadEmbeddingsMeta(otherTmp)).resolves.toBeNull();
      await saveEmbeddingsMeta(tmp, meta);
      await expect(loadEmbeddingsMeta(tmp)).resolves.toEqual(meta);
    } finally {
      await rm(otherTmp, { recursive: true, force: true });
    }
  });
});
