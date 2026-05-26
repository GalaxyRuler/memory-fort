import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLongMemEval } from "../../src/eval/longmemeval/runner.js";
import { writeManifest } from "../../src/eval/longmemeval/manifest.js";
import { runSearch } from "../../src/retrieval/search.js";

vi.mock("../../src/retrieval/search.js", () => ({
  runSearch: vi.fn(),
}));

describe("runLongMemEval", () => {
  let tmp: string;
  let datasetPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "longmemeval-runner-"));
    datasetPath = join(tmp, "questions.jsonl");
    await writeFile(datasetPath, [
      JSON.stringify({
        question_id: "q-1",
        question: "Where is the API decision?",
        expected_evidence_ids: ["wiki/decisions/api.md"],
        category: "single-hop",
        timestamp: "2026-05-20T00:00:00.000Z",
      }),
      JSON.stringify({
        question_id: "q-2",
        question: "Which page mentions cache invalidation?",
        expected_evidence_ids: ["wiki/lessons/cache.md"],
        category: "multi-hop",
        timestamp: "2026-05-21T00:00:00.000Z",
      }),
    ].join("\n"), "utf-8");
    await writeManifest(join(tmp, "manifest.json"), {
      dataset: "longmemeval-s",
      version: "hash:test",
      sha256: "test",
      sourceUrl: "https://example.test/longmemeval_s",
      downloadedAt: "2026-05-26T00:00:00.000Z",
      questionCount: 2,
    });
    vi.mocked(runSearch).mockReset();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("runs search for each question, scores recall, and records latency", async () => {
    vi.mocked(runSearch)
      .mockResolvedValueOnce(searchResponse(["wiki/decisions/api.md"], 11))
      .mockResolvedValueOnce(searchResponse([
        "wiki/nope.md",
        "wiki/lessons/cache.md",
      ], 29));

    const report = await runLongMemEval({
      datasetPath,
      vaultRoot: tmp,
      k: [1, 2],
    });

    expect(runSearch).toHaveBeenCalledTimes(2);
    expect(runSearch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      query: "Where is the API decision?",
      scope: "all",
      k: 2,
      vaultRoot: tmp,
    }));
    expect(report).toMatchObject({
      vaultRoot: tmp,
      datasetVersion: "hash:test",
      questionCount: 2,
      recall: { 1: 0.5, 2: 1 },
      meanLatencyMs: 20,
      p95LatencyMs: 29,
    });
    expect(report.durationMs).toEqual(expect.any(Number));
    expect(report.perQuestion[0]).toMatchObject({
      questionId: "q-1",
      expected: ["wiki/decisions/api.md"],
      retrieved: ["wiki/decisions/api.md"],
      hits: { 1: true, 2: true },
      latencyMs: 11,
    });
    expect(report.perQuestion[1]?.hits).toEqual({ 1: false, 2: true });
  });

  it("honors limit before running searches", async () => {
    vi.mocked(runSearch).mockResolvedValue(searchResponse(["wiki/decisions/api.md"], 5));

    const report = await runLongMemEval({ datasetPath, vaultRoot: tmp, limit: 1 });

    expect(runSearch).toHaveBeenCalledTimes(1);
    expect(report.questionCount).toBe(1);
  });
});

function searchResponse(paths: string[], totalMs: number) {
  return {
    query: "q",
    results: paths.map((path) => ({
      path,
      title: path,
      snippet: "",
      score: 1,
      source: "bm25",
      sources: [{ source: "bm25", rank: 1 }],
      kind: "wiki" as const,
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
      totalMs,
    },
    degraded: false,
    hyde: { used: false, reason: "not-triggered" as const },
    corpusErrorCount: 0,
  };
}
