import { describe, it, expect } from "vitest";
import {
  formatVerifyResult,
  runVerify,
  type VerifyCheckResult,
} from "../../../src/cli/commands/verify.js";

describe("runVerify", () => {
  it("returns exit 0 when every check passes", async () => {
    const result = await runVerify({
      now: () => new Date("2026-05-26T03:30:00.000Z"),
      checkFns: [
        async () => pass("vault read/write"),
        async () => pass("git remote vps reachable"),
        async () => pass("dashboard /api/status returns 200"),
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.warnings).toBe(0);
    expect(formatVerifyResult(result)).toContain("3/3 checks passed");
  });

  it("returns exit 1 when any check fails while warnings remain non-fatal", async () => {
    const result = await runVerify({
      now: () => new Date("2026-05-26T03:30:00.000Z"),
      checkFns: [
        async () => pass("vault read/write"),
        async () => warn("claude-code recent capture", "no captures in 24h"),
        async () =>
          fail(
            "claude-code plugin enabled",
            "run `memory connect claude-code` to fix",
          ),
      ],
    });

    expect(result.exitCode).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.warnings).toBe(1);
    expect(formatVerifyResult(result)).toContain("1/3 checks passed; 1 failed; 1 warning.");
  });

  it("formats fix commands beside failing checks", async () => {
    const result = await runVerify({
      now: () => new Date("2026-05-26T03:30:00.000Z"),
      checkFns: [
        async () =>
          fail("vscode MCP entry not in settings.json", "run `memory connect vscode`"),
      ],
    });

    expect(formatVerifyResult(result)).toContain(
      "✗ vscode MCP entry not in settings.json - run `memory connect vscode`",
    );
  });
});

function pass(label: string): VerifyCheckResult {
  return { id: label, label, status: "pass" };
}

function warn(label: string, detail: string): VerifyCheckResult {
  return { id: label, label, status: "warn", detail };
}

function fail(label: string, fix: string): VerifyCheckResult {
  return { id: label, label, status: "fail", fix };
}
