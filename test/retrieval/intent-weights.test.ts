import { describe, expect, it } from "vitest";
import {
  INTENT_WEIGHTS,
  applyIntentWeights,
} from "../../src/retrieval/intent-weights.js";
import { INTENT_LABELS } from "../../src/retrieval/query-intent.js";

describe("intent stream weights", () => {
  it("defines all six stream weights for every intent", () => {
    expect(Object.keys(INTENT_WEIGHTS).sort()).toEqual([...INTENT_LABELS].sort());
    for (const label of INTENT_LABELS) {
      expect(INTENT_WEIGHTS[label]).toEqual({
        bm25: expect.any(Number),
        vector: expect.any(Number),
        exact: expect.any(Number),
        graphBfs: expect.any(Number),
        spreadingActivation: expect.any(Number),
        metadata: expect.any(Number),
      });
    }
  });

  it("keeps open-ended weights uniform", () => {
    expect(Object.values(INTENT_WEIGHTS["open-ended"])).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("applies weights to named RRF streams", () => {
    const weighted = applyIntentWeights("code-context", [
      { source: "bm25", items: [{ relPath: "a", rank: 1 }] },
      { source: "graph", items: [{ relPath: "b", rank: 1 }] },
      { source: "graph-spread", items: [{ relPath: "c", rank: 1 }] },
    ]);

    expect(weighted).toEqual([
      { source: "bm25", weight: 1.4, items: [{ relPath: "a", rank: 1 }] },
      { source: "graph", weight: 1, items: [{ relPath: "b", rank: 1 }] },
      { source: "graph-spread", weight: 0.6, items: [{ relPath: "c", rank: 1 }] },
    ]);
  });
});
