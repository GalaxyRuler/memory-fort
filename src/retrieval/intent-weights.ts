import type { IntentLabel } from "./query-intent.js";
import type { RankedList } from "./rrf.js";

export interface StreamWeights {
  bm25: number;
  vector: number;
  exact: number;
  graphBfs: number;
  spreadingActivation: number;
  metadata: number;
}

export const INTENT_WEIGHTS: Record<IntentLabel, StreamWeights> = {
  decision: {
    bm25: 0.8,
    vector: 1.0,
    exact: 1.0,
    graphBfs: 1.3,
    spreadingActivation: 1.1,
    metadata: 1.4,
  },
  procedure: {
    bm25: 0.7,
    vector: 1.0,
    exact: 0.9,
    graphBfs: 1.0,
    spreadingActivation: 0.8,
    metadata: 1.3,
  },
  episodic: {
    bm25: 1.2,
    vector: 1.0,
    exact: 0.8,
    graphBfs: 0.7,
    spreadingActivation: 0.7,
    metadata: 1.1,
  },
  preference: {
    bm25: 0.9,
    vector: 1.1,
    exact: 1.0,
    graphBfs: 0.6,
    spreadingActivation: 0.6,
    metadata: 1.5,
  },
  "current-truth": {
    bm25: 0.9,
    vector: 1.0,
    exact: 1.0,
    graphBfs: 1.0,
    spreadingActivation: 0.7,
    metadata: 1.6,
  },
  "code-context": {
    bm25: 1.4,
    vector: 0.9,
    exact: 1.3,
    graphBfs: 1.0,
    spreadingActivation: 0.6,
    metadata: 0.8,
  },
  "open-ended": {
    bm25: 1.0,
    vector: 1.0,
    exact: 1.0,
    graphBfs: 1.0,
    spreadingActivation: 1.0,
    metadata: 1.0,
  },
};

export function applyIntentWeights<T extends RankedList>(
  intent: IntentLabel,
  lists: T[],
): Array<T & { weight: number }> {
  const weights = INTENT_WEIGHTS[intent];
  return lists.map((list) => ({
    ...list,
    weight: weightForSource(list.source, weights),
  }));
}

function weightForSource(source: string, weights: StreamWeights): number {
  switch (source) {
    case "bm25":
      return weights.bm25;
    case "vector":
      return weights.vector;
    case "exact":
      return weights.exact;
    case "graph":
      return weights.graphBfs;
    case "graph-spread":
      return weights.spreadingActivation;
    case "metadata":
      return weights.metadata;
    default:
      return 1;
  }
}
