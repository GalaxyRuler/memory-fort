import { describe, expect, it } from "vitest";
import {
  runPhase5RecallEvaluation,
  type Phase5RecallSearchFn,
} from "../../src/eval/retrieval/phase5-recall.js";

describe("Phase 5 recall gate metrics", () => {
  it("computes gates A/B/C/D/F/G from judged queries and search paths", async () => {
    const searchers = {
      legacy: pathsByQuery({
        alpha: ["wiki/a.md", "wiki/legacy-only.md", "wiki/b.md"],
        "alpha held out": ["wiki/a.md", "wiki/legacy-only.md"],
        "alpha hard paraphrase": ["wiki/legacy-only.md", "wiki/a.md"],
        beta: ["wiki/legacy-beta.md", "wiki/b.md"],
      }),
      indexHybrid: pathsByQuery({
        alpha: ["wiki/a.md", "wiki/vector.md", "wiki/b.md"],
        "alpha held out": ["wiki/a.md", "wiki/variant.md"],
        "alpha hard paraphrase": ["wiki/a.md", "wiki/hard.md"],
        beta: ["wiki/b.md", "wiki/vector.md"],
      }),
      indexLexical: pathsByQuery({
        alpha: ["wiki/noise.md", "wiki/a.md"],
        "alpha held out": ["wiki/a.md"],
        "alpha hard paraphrase": ["wiki/hard.md", "wiki/a.md"],
        beta: ["wiki/noise.md"],
      }),
      dtypes: {
        binary: pathsByQuery({
          alpha: ["wiki/a.md"],
          "alpha held out": ["wiki/a.md"],
          "alpha hard paraphrase": ["wiki/a.md"],
          beta: ["wiki/noise.md"],
        }),
        int8: pathsByQuery({
          alpha: ["wiki/a.md"],
          "alpha held out": ["wiki/a.md"],
          "alpha hard paraphrase": ["wiki/a.md"],
          beta: ["wiki/b.md"],
        }),
        float32: pathsByQuery({
          alpha: ["wiki/a.md"],
          "alpha held out": ["wiki/a.md"],
          "alpha hard paraphrase": ["wiki/a.md"],
          beta: ["wiki/b.md"],
        }),
      },
    };

    const report = await runPhase5RecallEvaluation({
      vaultRoot: "C:/vault",
      indexDbPath: "C:/index.db",
      judgedQueries: [
        {
          id: "q-alpha",
          query: "alpha",
          category: "known-target",
          type: "fact",
          expected_paths: ["wiki/a.md"],
          held_out_queries: ["alpha held out"],
          hard_held_out_queries: ["alpha hard paraphrase"],
        },
        {
          id: "q-beta",
          query: "beta",
          category: "ambiguous",
          type: "dependency",
          expected_paths: ["wiki/b.md"],
        },
      ],
      searchers,
      localVectorProfile: {
        provider: "local",
        modelId: "BAAI/bge-small-en-v1.5",
        dimension: 384,
        dtype: "binary-int8",
      },
    });

    expect(report.judgedQueryCount).toBe(4);
    expect(report.originalJudgedQueryCount).toBe(2);
    expect(report.heldOutQueryCount).toBe(1);
    expect(report.hardHeldOutQueryCount).toBe(1);
    expect(report.perQuery.map((query) => [query.id, query.queryVariant, query.parentId])).toEqual([
      ["q-alpha", "original", undefined],
      ["q-alpha:heldout:1", "held-out", "q-alpha"],
      ["q-alpha:hard-heldout:1", "hard-held-out", "q-alpha"],
      ["q-beta", "original", undefined],
    ]);
    expect(report.gates.A.top1Rate).toBe(1);
    expect(report.gates.A.top3Rate).toBe(1);
    expect(report.gates.B.top5.meanOverlapRate).toBeGreaterThan(0);
    expect(report.gates.C.hybridRecallAt10).toBeGreaterThan(report.gates.C.lexicalRecallAt10);
    expect(report.gates.D.localBgeSmallMeasured).toBe(true);
    expect(report.gates.F.hybridRecallAt10).toBe(report.gates.F.legacyRecallAt10);
    expect(report.gates.G?.recommendedDtype).toBe("int8");
  });
});

function pathsByQuery(rows: Record<string, string[]>): Phase5RecallSearchFn {
  return async ({ query }) => ({
    results: (rows[query] ?? []).map((path, index) => ({ path, rank: index + 1 })),
    latencyMs: 1,
    warnings: [],
  });
}
