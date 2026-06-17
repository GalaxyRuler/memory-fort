import { describe, expect, it } from "vitest";
import { evaluateVersionMatch } from "../../../../src/cli/commands/verify/build.js";

describe("build version match verify check", () => {
  it("passes when app, build, and package versions match", () => {
    expect(evaluateVersionMatch("0.8.5", "0.8.5", "0.8.5").status).toBe("pass");
  });

  it("fails when the dashboard app version is stale", () => {
    const result = evaluateVersionMatch("0.8.4", "0.8.5", "0.8.5");

    expect(result.status).toBe("fail");
    expect(result.suggestedFix).toMatch(/build/);
  });
});
