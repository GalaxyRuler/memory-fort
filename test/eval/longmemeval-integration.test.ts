import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLongMemEval } from "../../src/eval/longmemeval/runner.js";
import { formatLongMemEvalMarkdown } from "../../src/eval/longmemeval/report-markdown.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "fixtures", "longmemeval-tiny");

describe("LongMemEval integration fixture", () => {
  let tmp: string;
  let vaultRoot: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "longmemeval-integration-"));
    vaultRoot = join(tmp, "vault");
    await cp(join(fixtureRoot, "vault"), vaultRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("runs the real search pipeline against the tiny fixture", async () => {
    const report = await runLongMemEval({
      datasetPath: join(fixtureRoot, "questions.jsonl"),
      vaultRoot,
      k: [1, 5, 10],
    });

    expect(report.questionCount).toBe(10);
    expect(report.datasetVersion).toBe("unknown");
    expect(report.recall[5]).toBeGreaterThan(0.6);
    expect(report.meanLatencyMs).toBeGreaterThanOrEqual(0);
    expect(report.p95LatencyMs).toBeGreaterThanOrEqual(0);
    expect(report.perQuestion).toHaveLength(10);
    expect(report.perQuestion[0]).toMatchObject({
      questionId: expect.any(String),
      expected: expect.any(Array),
      retrieved: expect.any(Array),
      hits: expect.objectContaining({ 5: expect.any(Boolean) }),
      latencyMs: expect.any(Number),
    });

    const markdown = formatLongMemEvalMarkdown(report);
    expect(markdown).toContain("# LongMemEval-S Evaluation");
    expect(markdown).toContain("| Questions | 10 |");
  });
});
