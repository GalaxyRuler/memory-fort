import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dirname, "..", "..");

function runSummary(report: unknown): string {
  const tmpFile = join(tmpdir(), `eval-report-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(tmpFile, JSON.stringify(report));
  try {
    return execSync(`node scripts/ci-eval-summary.mjs < "${tmpFile}"`, {
      cwd: repoRoot,
      encoding: "utf-8",
      shell: process.platform === "win32" ? "cmd.exe" : undefined,
    });
  } finally {
    unlinkSync(tmpFile);
  }
}

describe("ci-eval-summary", () => {
  it("prints a retrieval markdown table", () => {
    const out = runSummary({
      recall: { "5": { withGraph: 0.8, withoutGraph: 0.6 }, "10": { withGraph: 0.9, withoutGraph: 0.7 } },
      mrr: { withGraph: 0.75, withoutGraph: 0.6 },
      graphLift: { "5": 0.2, "10": 0.2 },
      byType: {},
    });
    expect(out).toContain("R@5");
    expect(out).toContain("80.0%");
    expect(out).toContain("MRR");
    expect(out).toContain("75.0%");
  });

  it("prints a dispatch markdown table", () => {
    const out = runSummary({
      total: 10, correct: 8, accuracy: 0.8,
      byType: { novel: { total: 2, correct: 2, accuracy: 1.0 }, contradiction: { total: 2, correct: 2, accuracy: 1.0 } },
      results: [],
    });
    expect(out).toContain("Dispatch Policy Eval");
    expect(out).toContain("8/10");
    expect(out).toContain("80.0%");
  });
});
