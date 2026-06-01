import { describe, it, expect } from "vitest";
import {
  formatVerifyResult,
  parseVerifyRole,
  runVerify,
  type CheckDescriptor,
  type CheckResult,
} from "../../../src/cli/commands/verify.js";
import { memoryRoot } from "../../../src/storage/paths.js";

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
    expect(result.overallStatus).toBe("pass");
    expect(result.startedAt).toBe("2026-05-26T03:30:00.000Z");
    expect(result.finishedAt).toBe("2026-05-26T03:30:00.000Z");
    expect(result.role).toBe("operator");
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.warnings).toBe(0);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "vault read/write",
          status: "pass",
          durationMs: expect.any(Number),
        }),
      ]),
    );
    expect(formatVerifyResult(result)).toContain("3/3 checks passed");
    expect(formatVerifyResult(result)).toContain("Role: operator");
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
    expect(result.overallStatus).toBe("fail");
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
    expect(result.checks[0]?.suggestedFix).toBe("run `memory connect vscode`");
  });

  it("can be serialized as the machine-readable VerifyReport contract", async () => {
    const result = await runVerify({
      now: () => new Date("2026-05-26T03:30:00.000Z"),
      checkFns: [
        async () =>
          warn(
            "search pipeline",
            "search check skipped for shallow health endpoint",
            "retry with ?deep=true",
          ),
      ],
    });

    const parsed = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(parsed).toMatchObject({
      startedAt: "2026-05-26T03:30:00.000Z",
      finishedAt: "2026-05-26T03:30:00.000Z",
      overallStatus: "warn",
      role: "operator",
      checks: [
        {
          id: "search pipeline",
          label: "search pipeline",
          status: "warn",
          detail: "search check skipped for shallow health endpoint",
          suggestedFix: "retry with ?deep=true",
        },
      ],
    });
    expect(parsed.checks[0]?.durationMs).toEqual(expect.any(Number));
  });

  it("runs only checks assigned to the selected role", async () => {
    const seen: string[] = [];
    const result = await runVerify({
      role: "server",
      now: () => new Date("2026-05-26T03:30:00.000Z"),
      checkDescriptors: [
        descriptor("shared", ["operator", "server"], seen),
        descriptor("operator-only", ["operator"], seen),
      ],
    });

    expect(seen).toEqual(["shared"]);
    expect(result.role).toBe("server");
    expect(result.checks.map((check) => check.id)).toEqual(["shared"]);
  });

  it("auto-detects the role when no role is provided", async () => {
    const result = await runVerify({
      detectRoleFn: () => "server",
      now: () => new Date("2026-05-26T03:30:00.000Z"),
      checkDescriptors: [descriptor("server check", ["server"])],
    });

    expect(result.role).toBe("server");
    expect(result.checks.map((check) => check.id)).toEqual(["server check"]);
  });

  it("parses verify role flag values", () => {
    expect(parseVerifyRole(undefined)).toBeUndefined();
    expect(parseVerifyRole("server")).toBe("server");
    expect(parseVerifyRole("operator")).toBe("operator");
    expect(() => parseVerifyRole("bogus")).toThrow("invalid role");
  });

  it("passes an explicit vaultRoot to descriptor checks", async () => {
    const seen: string[] = [];
    await runVerify({
      vaultRoot: "C:/tmp/memory-vault",
      now: () => new Date("2026-05-26T03:30:00.000Z"),
      checkDescriptors: [vaultRootDescriptor(seen)],
    });

    expect(seen).toEqual(["C:/tmp/memory-vault"]);
  });

  it("passes explicit dashboard and remote overrides to descriptor checks", async () => {
    const seen: Array<{ dashboardUrl?: string; remoteName?: string }> = [];
    await runVerify({
      dashboardUrl: "https://whitedragon.example/memory",
      remoteName: "whitedragon",
      now: () => new Date("2026-05-26T03:30:00.000Z"),
      checkDescriptors: [
        {
          id: "override-capture",
          label: "override capture",
          roles: ["operator"],
          async run(opts) {
            seen.push({
              dashboardUrl: opts.dashboardUrl,
              remoteName: opts.remoteName,
            });
            return pass("override-capture");
          },
        },
      ],
    });

    expect(seen).toEqual([
      {
        dashboardUrl: "https://whitedragon.example/memory",
        remoteName: "whitedragon",
      },
    ]);
  });

  it("uses memoryRoot when no explicit vaultRoot is provided", async () => {
    const seen: string[] = [];
    await runVerify({
      now: () => new Date("2026-05-26T03:30:00.000Z"),
      checkDescriptors: [vaultRootDescriptor(seen)],
    });

    expect(seen).toEqual([memoryRoot()]);
  });
});

function pass(label: string): CheckResult {
  return { id: label, label, status: "pass", durationMs: 0 };
}

function warn(label: string, detail: string, suggestedFix?: string): CheckResult {
  return { id: label, label, status: "warn", detail, suggestedFix, durationMs: 0 };
}

function fail(label: string, suggestedFix: string): CheckResult {
  return { id: label, label, status: "fail", suggestedFix, durationMs: 0 };
}

function descriptor(
  id: string,
  roles: CheckDescriptor["roles"],
  seen: string[] = [],
): CheckDescriptor {
  return {
    id,
    label: id,
    roles,
    async run() {
      seen.push(id);
      return pass(id);
    },
  };
}

function vaultRootDescriptor(seen: string[]): CheckDescriptor {
  return {
    id: "vault-root-capture",
    label: "vault root capture",
    roles: ["operator", "server"],
    async run(opts) {
      seen.push(opts.vaultRoot);
      return pass("vault-root-capture");
    },
  };
}
