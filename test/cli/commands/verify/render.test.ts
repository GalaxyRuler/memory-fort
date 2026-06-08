import { describe, expect, it } from "vitest";
import { formatVerifyResult } from "../../../../src/cli/commands/verify/render.js";

describe("formatVerifyResult skip handling", () => {
  it("renders skip with a neutral marker and excludes it from pass/fail/warn counts", () => {
    const out = formatVerifyResult({
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      role: "operator",
      overallStatus: "pass",
      checks: [
        { id: "a", label: "A ok", status: "pass", durationMs: 0 },
        { id: "b", label: "B off", status: "skip", detail: "client disabled", durationMs: 0 },
      ],
      passed: 1,
      failed: 0,
      warnings: 0,
    });
    expect(out).toContain("B off");
    expect(out).toContain("skipped");
    expect(out).not.toContain("1 failed");
    expect(out).not.toContain("1 warning");
  });

  it("summary line shows correct denominator and skipped count", () => {
    const out = formatVerifyResult({
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      role: "operator",
      overallStatus: "pass",
      checks: [
        { id: "a", label: "A ok", status: "pass", durationMs: 0 },
        { id: "b", label: "B off", status: "skip", detail: "client disabled", durationMs: 0 },
      ],
      passed: 1,
      failed: 0,
      warnings: 0,
    });
    // Summary must read "1/2 checks passed" (total includes skip) and "1 skipped"
    expect(out).toMatch(/1\/2 checks passed.*1 skipped/s);
    // Detail text for the skip check must appear in the output
    expect(out).toContain("client disabled");
  });

  it("skip check without detail renders (skipped) and no stray dash", () => {
    const out = formatVerifyResult({
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      role: "operator",
      overallStatus: "pass",
      checks: [
        { id: "x", label: "X off", status: "skip", durationMs: 0 },
      ],
      passed: 0,
      failed: 0,
      warnings: 0,
    });
    expect(out).toContain("(skipped)");
    // The skip line should be "  ○ X off (skipped)" — no " - " separator
    const skipLine = out.split("\n").find((l) => l.includes("X off"));
    expect(skipLine).toBeDefined();
    expect(skipLine).not.toContain(" - ");
  });
});
