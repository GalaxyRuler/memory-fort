import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphHealthReport } from "../../../../src/dashboard/graph-health.js";
import { graphCohesionCheck } from "../../../../src/cli/commands/verify/graph-cohesion.js";
import { computeGraphHealth } from "../../../../src/dashboard/graph-health.js";
import { loadGraphFeed } from "../../../../src/dashboard/loaders.js";

vi.mock("../../../../src/dashboard/loaders.js", () => ({
  loadGraphFeed: vi.fn(),
}));

vi.mock("../../../../src/dashboard/graph-health.js", () => ({
  computeGraphHealth: vi.fn(),
}));

const mockLoadGraphFeed = vi.mocked(loadGraphFeed);
const mockComputeGraphHealth = vi.mocked(computeGraphHealth);

describe("graphCohesionCheck", () => {
  beforeEach(() => {
    mockLoadGraphFeed.mockResolvedValue({ nodes: [], edges: [], unresolvedTargets: [] });
  });

  it("passes when all graph metrics pass", async () => {
    mockComputeGraphHealth.mockReturnValue(report("pass", [
      metric("graph.edge-type-entropy", "pass"),
      metric("graph.narrative-thread-coverage", "n/a"),
    ]));

    const result = await graphCohesionCheck.run({ vaultRoot: "/vault", now: () => new Date() });

    expect(mockLoadGraphFeed).toHaveBeenCalledWith("/vault", "all");
    expect(result).toMatchObject({
      id: "graph.cohesion",
      label: "graph cohesion: all metrics passing",
      status: "pass",
    });
  });

  it("warns with the count and ids for warning metrics", async () => {
    mockComputeGraphHealth.mockReturnValue(report("warn", [
      metric("graph.hub-overload", "warn"),
      metric("graph.temporal-coverage", "warn"),
    ]));

    const result = await graphCohesionCheck.run({ vaultRoot: "/vault", now: () => new Date() });

    expect(result).toMatchObject({
      id: "graph.cohesion",
      label: "graph cohesion: 2 metrics in warn",
      status: "warn",
      detail: "graph.hub-overload, graph.temporal-coverage",
    });
  });

  it("fails with failing metric ids and dashboard guidance", async () => {
    mockComputeGraphHealth.mockReturnValue(report("fail", [
      metric("graph.confidence-coverage", "fail"),
      metric("graph.agent-attribution", "fail"),
      metric("graph.hub-overload", "warn"),
    ]));

    const result = await graphCohesionCheck.run({ vaultRoot: "/vault", now: () => new Date() });

    expect(result).toMatchObject({
      id: "graph.cohesion",
      label: "graph cohesion: graph.confidence-coverage, graph.agent-attribution in fail",
      status: "fail",
      detail: "graph.confidence-coverage, graph.agent-attribution",
      suggestedFix: "open the dashboard Graph Health panel",
    });
  });
});

function report(
  overallStatus: GraphHealthReport["overallStatus"],
  metrics: GraphHealthReport["metrics"],
): GraphHealthReport {
  return {
    computedAt: "2026-05-27T00:00:00.000Z",
    overallStatus,
    metrics,
  };
}

function metric(id: string, status: GraphHealthReport["overallStatus"]): GraphHealthReport["metrics"][number] {
  return {
    id,
    label: id,
    value: 1,
    threshold: {},
    status,
    detail: "",
    topOffenders: [],
  };
}
