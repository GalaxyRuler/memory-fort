import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRetrievalEval } from "../../src/eval/retrieval/runner.js";
import type { SearchResponse } from "../../src/retrieval/search.js";

describe("retrieval gold eval runner", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "retrieval-eval-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("computes Recall@K, MRR, per-type breakdown, and graph lift", async () => {
    const goldPath = join(tmp, "retrieval-gold.jsonl");
    await writeFile(
      goldPath,
      [
        JSON.stringify({
          query: "what fixed the cache outage",
          expected_paths: ["wiki/issues/cache-outage.md"],
          type: "causal",
        }),
        JSON.stringify({
          query: "which tool does memory use for embeddings",
          expected_paths: ["wiki/tools/voyageai.md"],
          type: "dependency",
        }),
      ].join("\n"),
    );

    const search = vi.fn(async (opts: { graphSpread?: boolean; query: string }) => {
      if (opts.graphSpread === false) {
        return searchResponse(opts.query, ["wiki/references/unrelated.md"]);
      }
      return searchResponse(
        opts.query,
        opts.query.includes("cache")
          ? ["wiki/references/unrelated.md", "wiki/issues/cache-outage.md"]
          : ["wiki/tools/voyageai.md"],
      );
    });

    const report = await runRetrievalEval({
      goldPath,
      vaultRoot: tmp,
      k: [5, 10],
      search,
    });

    expect(search).toHaveBeenCalledTimes(4);
    expect(report.questionCount).toBe(2);
    expect(report.recall[5]?.withGraph).toBe(1);
    expect(report.recall[5]?.withoutGraph).toBe(0);
    expect(report.graphLift[5]).toBe(1);
    expect(report.mrr.withGraph).toBe(0.75);
    expect(report.byType.causal?.mrr.withGraph).toBe(0.5);
    expect(report.perQuestion[0]).toMatchObject({
      type: "causal",
      withGraph: { reciprocalRank: 0.5 },
      withoutGraph: { reciprocalRank: 0 },
    });
  });
});

function searchResponse(query: string, paths: string[]): SearchResponse {
  return {
    query,
    results: paths.map((path, index) => ({
      path,
      title: path,
      snippet: "",
      score: 1 - index * 0.01,
      source: "test",
      sources: [{ source: "test", rank: index + 1 }],
      kind: "wiki",
    })),
    warnings: [],
    timings: {
      corpusMs: 0,
      refreshMs: 0,
      embedQueryMs: 0,
      bm25Ms: 0,
      vectorMs: 0,
      exactMs: 0,
      graphMs: 0,
      graphSpreadMs: 0,
      metadataMs: 0,
      rrfMs: 0,
      rerankMs: 0,
      totalMs: 12,
      intentClassification: {
        label: "open-ended",
        confidence: 1,
        method: "fallback",
        latencyMs: 0,
      },
    },
    degraded: false,
    hyde: { used: false, reason: "not-triggered" },
    corpusErrorCount: 0,
    bm25Cache: {
      indexCacheHit: false,
      documentCount: 0,
      tokenCacheHits: 0,
      tokenCacheMisses: 0,
    },
  };
}
