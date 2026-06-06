import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkEmbeddingHealth,
} from "../../../../src/cli/commands/verify/embedding-health.js";
import { saveEmbeddings, type EmbeddingKind, type EmbeddingRecord } from "../../../../src/retrieval/embeddings-store.js";

describe("embedding health verify check", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "embedding-health-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("warns when no embedding sidecars exist", async () => {
    const result = await checkEmbeddingHealth(tmp, {
      configLoader: async () => ({ embedding: { dim: 2048 } }),
    });

    expect(result.status).toBe("warn");
    expect(result.id).toBe("retrieval.embedding-health");
    expect(result.detail).toContain("vector retrieval is inactive");
  });

  it("fails when embeddings are dim-3 identical stubs", async () => {
    await writeEmbeddingSidecar(tmp, "wiki", [
      embedding("wiki/decisions/a.md", [1, 0, 0]),
      embedding("wiki/decisions/b.md", [1, 0, 0]),
    ]);
    await writeEmbeddingSidecar(tmp, "raw", [
      embedding("raw/2026-06-03/codex-1.md", [1, 0, 0]),
    ]);

    const result = await checkEmbeddingHealth(tmp, {
      configLoader: async () => ({ embedding: { dim: 2048 } }),
    });

    expect(result.status).toBe("fail");
    expect(result.suggestedFix).toContain("provider reindex-embeddings --apply");
    expect(result.detail).toContain("dim 3");
    expect(result.detail).toContain("identical");
  });

  it("passes when sampled embeddings are diverse and match configured dimensions", async () => {
    await saveEmbeddings(tmp, "wiki", [
      embedding("wiki/decisions/a.md", vector(0)),
      embedding("wiki/decisions/b.md", vector(1)),
    ]);
    await saveEmbeddings(tmp, "raw", [
      embedding("raw/2026-06-03/codex-1.md", vector(2)),
    ]);

    const result = await checkEmbeddingHealth(tmp, {
      configLoader: async () => ({ embedding: { dim: 16 } }),
      env: { VOYAGE_API_KEY: "visible" },
    });

    expect(result).toMatchObject({ status: "pass" });
    expect(result.detail).toContain("3 embedding records");
  });

  it("includes auto-heal status in the operator-visible detail", async () => {
    await saveEmbeddings(tmp, "wiki", [
      embedding("wiki/decisions/a.md", vector(0, 2048)),
      embedding("wiki/decisions/b.md", vector(1, 2048)),
    ], { expectedDim: 2048 });

    const result = await checkEmbeddingHealth(tmp, {
      configLoader: async () => ({ embedder: { provider: "voyage", model: "voyage-4-large" } }),
      env: { VOYAGE_API_KEY: "visible" },
      autoHealStatusReader: async () => ({
        enabled: true,
        lastTick: "2026-06-04T10:00:00.000Z",
        lastEmbed: "2026-06-04T10:00:01.000Z",
        dailySpendUsd: 0.001,
        dailyBudgetUsd: 0.5,
        nextReset: "2026-06-05T00:00:00.000Z",
      }),
    });

    expect(result.status).toBe("pass");
    expect(result.detail).toContain("auto-heal enabled");
    expect(result.detail).toContain("$0.0010/$0.5000");
  });

  it("fails loudly when stored embeddings are healthy but the active provider key is missing in this process", async () => {
    await saveEmbeddings(tmp, "wiki", [
      embedding("wiki/decisions/a.md", vector(0, 2048)),
      embedding("wiki/decisions/b.md", vector(1, 2048)),
    ], { expectedDim: 2048 });

    const result = await checkEmbeddingHealth(tmp, {
      configLoader: async () => ({ embedder: { provider: "voyage", model: "voyage-4-large" } }),
      env: {},
    });

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("VOYAGE_API_KEY missing in this process");
    expect(result.suggestedFix).toContain("restart long-running services");
  });
});

function embedding(path: string, vector: number[]): EmbeddingRecord {
  return {
    path,
    vector,
    hash: `hash-${path}`,
    model: "test",
    dim: vector.length,
    ts: "2026-06-03T00:00:00.000Z",
  };
}

function vector(primaryIndex: number, dim = 16): number[] {
  const values = Array.from({ length: dim }, () => 0);
  values[primaryIndex] = 1;
  return values;
}

async function writeEmbeddingSidecar(
  root: string,
  kind: EmbeddingKind,
  records: EmbeddingRecord[],
): Promise<void> {
  await mkdir(join(root, "embeddings"), { recursive: true });
  await writeFile(
    join(root, "embeddings", `${kind}.embeddings.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}
