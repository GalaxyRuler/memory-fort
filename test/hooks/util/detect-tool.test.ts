import { describe, it, expect } from "vitest";
import { detectTool } from "../../../src/hooks/util/detect-tool.js";

describe("detectTool", () => {
  it("returns claude-code when CLAUDECODE=1", () => {
    expect(detectTool({ env: { CLAUDECODE: "1" } })).toBe("claude-code");
  });

  it("returns codex when CLAUDECODE absent", () => {
    expect(detectTool({ env: {} })).toBe("codex");
  });

  it("returns codex when CLAUDECODE=0 (not strictly '1')", () => {
    expect(detectTool({ env: { CLAUDECODE: "0" } })).toBe("codex");
  });

  it("returns codex when CLAUDECODE=true (not strictly '1')", () => {
    expect(detectTool({ env: { CLAUDECODE: "true" } })).toBe("codex");
  });

  it("defaults to reading process.env when env not provided", () => {
    const result = detectTool();
    expect(["claude-code", "codex"]).toContain(result);
  });

  it("ignores payload when env unambiguous", () => {
    expect(
      detectTool({
        env: { CLAUDECODE: "1" },
        payload: { entrypoint: "something-else" },
      }),
    ).toBe("claude-code");
  });
});
