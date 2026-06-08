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
});
