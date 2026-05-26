import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseEvalLongMemEvalOptions,
  runEvalLongMemEval,
} from "../../../src/cli/commands/eval-longmemeval.js";
import type { LongMemEvalReport } from "../../../src/eval/longmemeval/types.js";

describe("eval longmemeval CLI command", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "eval-longmemeval-cli-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("parses command flags into runner options", () => {
    const parsed = parseEvalLongMemEvalOptions({
      corpus: "vault",
      dataset: "dataset.jsonl",
      k: "1,5,20",
      limit: "10",
      baseline: "0.81",
      output: "report.json",
      markdown: "report.md",
      verbose: true,
    }, "2026-05-26T01-30-00-000Z");

    expect(parsed).toMatchObject({
      vaultRoot: "vault",
      datasetPath: "dataset.jsonl",
      k: [1, 5, 20],
      limit: 10,
      baseline: 0.81,
      outputPath: "report.json",
      markdownPath: "report.md",
      verbose: true,
    });
  });

  it("writes JSON and markdown reports, prints a summary, and exits 0 above baseline", async () => {
    const outputPath = join(tmp, "report.json");
    const markdownPath = join(tmp, "report.md");
    const runner = vi.fn(async () => reportFixture({ recall5: 0.95 }));

    const result = await runEvalLongMemEval({
      corpus: tmp,
      dataset: join(tmp, "questions.jsonl"),
      output: outputPath,
      markdown: markdownPath,
      runner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("LongMemEval-S | R@1=0.78 | R@5=0.95 | R@10=0.97 | mean=124ms | p95=380ms | n=2");
    expect(JSON.parse(await readFile(outputPath, "utf-8"))).toMatchObject({
      questionCount: 2,
      recall: { 5: 0.95 },
    });
    expect(await readFile(markdownPath, "utf-8")).toContain("# LongMemEval-S Evaluation");
    expect(runner).toHaveBeenCalledWith({
      datasetPath: join(tmp, "questions.jsonl"),
      vaultRoot: tmp,
      k: [1, 5, 10],
      limit: undefined,
    });
  });

  it("defaults reports under wiki/.audit with timestamped names", async () => {
    const runner = vi.fn(async () => reportFixture({ recall5: 0.95 }));

    const result = await runEvalLongMemEval({
      cwd: tmp,
      now: () => new Date("2026-05-26T01:30:00.000Z"),
      runner,
    });

    expect(result.outputPath).toBe(join(tmp, "wiki", ".audit", "longmemeval-2026-05-26T01-30-00-000Z.json"));
    expect(result.markdownPath).toBe(join(tmp, "wiki", ".audit", "longmemeval-2026-05-26T01-30-00-000Z.md"));
  });

  it("exits 1 when Recall@5 is below the baseline", async () => {
    const runner = vi.fn(async () => reportFixture({ recall5: 0.5 }));

    const result = await runEvalLongMemEval({
      corpus: tmp,
      dataset: join(tmp, "questions.jsonl"),
      output: join(tmp, "report.json"),
      markdown: join(tmp, "report.md"),
      baseline: "0.92",
      runner,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Recall@5 0.50 fell below baseline 0.92");
  });
});

function reportFixture(opts: { recall5: number }): LongMemEvalReport {
  return {
    startedAt: "2026-05-26T01:30:00.000Z",
    finishedAt: "2026-05-26T01:30:02.500Z",
    durationMs: 2500,
    vaultRoot: "C:/tmp/memory",
    datasetVersion: "hash:test",
    questionCount: 2,
    recall: { 1: 0.78, 5: opts.recall5, 10: 0.97 },
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
        retrieved: ["wiki/lessons/cache.md"],
        hits: { 1: false, 5: true, 10: true },
        latencyMs: 148,
      },
    ],
  };
}
