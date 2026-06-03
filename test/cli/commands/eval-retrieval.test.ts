import { describe, expect, it, vi } from "vitest";
import {
  parseEvalRetrievalOptions,
  runEvalRetrieval,
} from "../../../src/cli/commands/eval-retrieval.js";
import type { RetrievalEvalReport } from "../../../src/eval/retrieval/types.js";

describe("eval-retrieval CLI command", () => {
  it("parses command flags into runner options", () => {
    const parsed = parseEvalRetrievalOptions({
      corpus: "vault",
      gold: "gold.jsonl",
      k: "5,10,20",
      limit: "7",
      json: true,
      cwd: "C:/repo",
    });

    expect(parsed).toMatchObject({
      vaultRoot: "vault",
      goldPath: "gold.jsonl",
      k: [5, 10, 20],
      limit: 7,
      json: true,
    });
  });

  it("prints JSON and exits 0 when graph lift is positive", async () => {
    const runner = vi.fn(async () => reportFixture({ lift5: 0.2 }));

    const result = await runEvalRetrieval({
      corpus: "vault",
      gold: "gold.jsonl",
      json: true,
      runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      questionCount: 2,
      graphLift: { 5: 0.2 },
    });
    expect(runner).toHaveBeenCalledWith({
      vaultRoot: "vault",
      goldPath: "gold.jsonl",
      k: [5, 10],
      limit: undefined,
    });
  });

  it("surfaces non-positive graph lift loudly", async () => {
    const runner = vi.fn(async () => reportFixture({ lift5: 0 }));

    const result = await runEvalRetrieval({
      corpus: "vault",
      gold: "gold.jsonl",
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Graph lift@5 0.00 is not positive");
    expect(result.stdout).toContain("Retrieval gold | R@5");
  });
});

function reportFixture(opts: { lift5: number }): RetrievalEvalReport {
  return {
    startedAt: "2026-06-03T00:00:00.000Z",
    finishedAt: "2026-06-03T00:00:01.000Z",
    durationMs: 1000,
    vaultRoot: "vault",
    goldPath: "gold.jsonl",
    questionCount: 2,
    recall: {
      5: { withGraph: 0.8, withoutGraph: 0.8 - opts.lift5 },
      10: { withGraph: 1, withoutGraph: 0.9 },
    },
    graphLift: {
      5: opts.lift5,
      10: 0.1,
    },
    mrr: {
      withGraph: 0.75,
      withoutGraph: 0.5,
    },
    byType: {},
    perQuestion: [],
  };
}
