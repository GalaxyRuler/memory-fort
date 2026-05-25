import { describe, expect, it } from "vitest";
import {
  spreadingActivation,
  type Edge,
  type SearchGraph,
} from "../../src/retrieval/graph.js";

describe("spreadingActivation", () => {
  it("decays strictly down an outbound chain", () => {
    const graph = graphFromEdges([
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ]);

    const result = spreadingActivation(new Set(["a"]), graph, {
      followDirection: "outbound",
      decay: 0.5,
      inhibitionLambda: 0,
      maxIterations: 5,
    });

    expect(result.map((item) => item.path)).toEqual(["a", "b", "c", "d"]);
    expect(activation(result, "a")).toBeGreaterThan(activation(result, "b"));
    expect(activation(result, "b")).toBeGreaterThan(activation(result, "c"));
    expect(activation(result, "c")).toBeGreaterThan(activation(result, "d"));
  });

  it("combines converging paths while inhibiting competing siblings", () => {
    const graph = graphFromEdges([
      ["a", "b"],
      ["a", "c"],
      ["b", "d"],
      ["c", "d"],
    ]);

    const result = spreadingActivation(new Set(["a"]), graph, {
      followDirection: "outbound",
      decay: 0.6,
      inhibitionLambda: 0.15,
      maxIterations: 5,
    });

    expect(activation(result, "b")).toBeCloseTo(0.51, 5);
    expect(activation(result, "c")).toBeCloseTo(0.51, 5);
    expect(activation(result, "d")).toBeGreaterThan(activation(result, "b"));
    expect(result.map((item) => item.path)).toEqual(["a", "d", "b", "c"]);
  });

  it("omits disconnected components", () => {
    const graph = graphFromEdges([
      ["a", "b"],
      ["x", "y"],
    ]);

    const result = spreadingActivation(new Set(["a"]), graph, {
      followDirection: "outbound",
    });

    expect(result.map((item) => item.path)).toEqual(["a", "b"]);
  });

  it("handles a 1000-node chain quickly", () => {
    const edges = Array.from({ length: 999 }, (_, index): [string, string] => [
      `node-${index}`,
      `node-${index + 1}`,
    ]);
    const graph = graphFromEdges(edges);
    const started = performance.now();

    const result = spreadingActivation(new Set(["node-0"]), graph, {
      followDirection: "outbound",
      decay: 0.9,
      inhibitionLambda: 0,
      epsilon: 0,
      maxIterations: 999,
    });

    expect(performance.now() - started).toBeLessThan(100);
    expect(result).toHaveLength(1000);
    expect(result[0]).toEqual({ path: "node-0", activation: 1 });
    expect(result.at(-1)?.path).toBe("node-999");
  });
});

function activation(
  result: Array<{ path: string; activation: number }>,
  path: string,
): number {
  return result.find((item) => item.path === path)?.activation ?? 0;
}

function graphFromEdges(pairs: Array<[string, string]>): SearchGraph {
  const paths = new Set(pairs.flat());
  const nodes = new Map(
    [...paths].map((path) => [
      path,
      {
        path,
        outbound: [] as Edge[],
        inbound: [] as Edge[],
      },
    ]),
  );
  const edges = pairs.map(([fromPath, toPath]): Edge => ({
    fromPath,
    toPath,
    kind: "relation",
    relationType: "relates",
  }));

  for (const edge of edges) {
    nodes.get(edge.fromPath)?.outbound.push(edge);
    nodes.get(edge.toPath)?.inbound.push(edge);
  }

  return { nodes, edges, unresolvedTargets: [] };
}
