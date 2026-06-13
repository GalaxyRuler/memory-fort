import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadEmbeddings,
  saveEmbeddings,
  updateEmbeddings,
  type EmbeddingRecord,
} from "../../src/retrieval/embeddings-store.js";

function record(path: string): EmbeddingRecord {
  return {
    path,
    hash: `hash-${path}`,
    vector: [0.5, 0.25, 0.125],
    model: "test-model",
    dim: 3,
    ts: "2026-06-12T00:00:00Z",
  };
}

describe("updateEmbeddings", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "embeddings-lock-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("applies the update to current records and persists", async () => {
    await saveEmbeddings(root, "wiki", [record("wiki/a.md")]);
    await updateEmbeddings(root, "wiki", (records) => [...records, record("wiki/b.md")]);
    const { records } = await loadEmbeddings(root, "wiki");
    expect(records.map((r) => r.path).sort()).toEqual(["wiki/a.md", "wiki/b.md"]);
  });

  it("does not lose records under concurrent updates", async () => {
    await saveEmbeddings(root, "wiki", [record("wiki/base.md")]);
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        updateEmbeddings(root, "wiki", (records) => [...records, record(`wiki/p${i}.md`)]),
      ),
    );
    const { records } = await loadEmbeddings(root, "wiki");
    expect(records).toHaveLength(7);
  });
});
