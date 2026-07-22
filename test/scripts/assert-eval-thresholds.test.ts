import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const scriptPath = join(repoRoot, "scripts", "assert-eval-thresholds.mjs");
const thresholdsPath = join(repoRoot, "qa", "eval-thresholds.json");
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function retrievalReport() {
  return {
    questionCount: 12,
    recall: {
      5: { withGraph: 1, withoutGraph: 1 },
      10: { withGraph: 1, withoutGraph: 1 },
    },
    graphLift: { 5: 0, 10: 0 },
    mrr: { withGraph: 0.8472, withoutGraph: 0.7917 },
    byType: {
      fact: { questionCount: 3 },
      causal: { questionCount: 1 },
      temporal: { questionCount: 1 },
      dependency: { questionCount: 5 },
      provenance: { questionCount: 2 },
    },
    perQuestion: [],
  };
}

function dispatchReport() {
  const byType = Object.fromEntries(
    ["duplicate", "contradiction", "supersession", "novel", "noop"].map((type) => [
      type,
      { total: 1, correct: 1, accuracy: 1 },
    ]),
  );
  return { total: 10, correct: 10, accuracy: 1, byType, results: [] };
}

function writeReport(report: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-fort-eval-gate-"));
  tempDirs.push(dir);
  const path = join(dir, "report.json");
  writeFileSync(path, JSON.stringify(report));
  return path;
}

function run(kind: "retrieval" | "dispatch", report: unknown) {
  return spawnSync(
    process.execPath,
    [scriptPath, "--kind", kind, "--report", writeReport(report), "--thresholds", thresholdsPath],
    { cwd: repoRoot, encoding: "utf-8" },
  );
}

describe("assert-eval-thresholds", () => {
  it("accepts the frozen v0.13.0 retrieval baseline", () => {
    const result = run("retrieval", retrievalReport());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("retrieval thresholds passed");
  });

  it("fails when retrieval recall regresses", () => {
    const report = retrievalReport();
    report.recall[5]!.withGraph = 0.9;

    const result = run("retrieval", report);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recall@5.withGraph");
  });

  it("fails when a required retrieval category is missing", () => {
    const report = retrievalReport();
    delete report.byType.provenance;

    const result = run("retrieval", report);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required category: provenance");
  });

  it("fails when reported graph lift is inconsistent with recall", () => {
    const report = retrievalReport();
    report.graphLift[5] = 0.2;

    const result = run("retrieval", report);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("graphLift@5 is inconsistent");
  });

  it("accepts the frozen v0.13.0 dispatch baseline", () => {
    const result = run("dispatch", dispatchReport());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dispatch thresholds passed");
  });

  it("fails when a dispatch category falls below its floor", () => {
    const report = dispatchReport();
    report.byType.noop = { total: 1, correct: 0, accuracy: 0 };
    report.correct = 9;
    report.accuracy = 0.9;

    const result = run("dispatch", report);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dispatch category noop accuracy");
  });

  it("fails closed on malformed report JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-fort-eval-gate-"));
    tempDirs.push(dir);
    const reportPath = join(dir, "report.json");
    writeFileSync(reportPath, "{not-json");

    expect(() =>
      execFileSync(
        process.execPath,
        [scriptPath, "--kind", "retrieval", "--report", reportPath, "--thresholds", thresholdsPath],
        { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" },
      ),
    ).toThrow();
  });
});
