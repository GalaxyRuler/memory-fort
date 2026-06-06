import { describe, expect, it } from "vitest";
import { formatLongMemEvalMarkdown } from "../../src/eval/longmemeval/report-markdown.js";
import type { LongMemEvalReport } from "../../src/eval/longmemeval/types.js";

describe("formatLongMemEvalMarkdown", () => {
  it("renders summary metrics and R@5 failures", () => {
    const markdown = formatLongMemEvalMarkdown(reportFixture());

    expect(markdown).toContain("# LongMemEval-S Evaluation - 2026-05-26T01:30:00.000Z");
    expect(markdown).toContain("| Questions | 2 |");
    expect(markdown).toContain("| R@5 | 0.50 |");
    expect(markdown).toContain("## Failures (R@5 misses, 1 total)");
    expect(markdown).toContain('- [q-2] "Where was the cache note?"');
    expect(markdown).toContain("Expected: wiki/lessons/cache.md");
    expect(markdown).toContain("Retrieved: [wiki/other.md]");
  });
});

function reportFixture(): LongMemEvalReport {
  return {
    startedAt: "2026-05-26T01:30:00.000Z",
    finishedAt: "2026-05-26T01:30:02.500Z",
    durationMs: 2500,
    vaultRoot: "C:/tmp/memory",
    datasetVersion: "hash:test",
    questionCount: 2,
    recall: { 1: 0.5, 5: 0.5, 10: 1 },
    meanLatencyMs: 124,
    p95LatencyMs: 380,
    perQuestion: [
      {
        questionId: "q-1",
        question: "Where was the API note?",
        expected: ["wiki/decisions/api.md"],
        retrieved: ["wiki/decisions/api.md"],
        hits: { 1: true, 5: true, 10: true },
        latencyMs: 100,
      },
      {
        questionId: "q-2",
        question: "Where was the cache note?",
        expected: ["wiki/lessons/cache.md"],
        retrieved: ["wiki/other.md"],
        hits: { 1: false, 5: false, 10: true },
        latencyMs: 148,
      },
    ],
  };
}
