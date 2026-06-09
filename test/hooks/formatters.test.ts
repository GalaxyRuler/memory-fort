import { describe, it, expect } from "vitest";
import { formatSummaryBlock } from "../../src/hooks/raw-file.js";

describe("formatSummaryBlock", () => {
  const fixedNow = new Date(Date.UTC(2026, 5, 9, 14, 30, 0));

  it("produces a heading with (summary) marker", () => {
    const result = formatSummaryBlock({
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolOutput: "PASS all tests\nDone in 3.2s",
      now: fixedNow,
    });
    expect(result).toContain("## [14:30:00] ToolUse: Bash (summary)");
  });

  it("includes input in json code block", () => {
    const result = formatSummaryBlock({
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolOutput: "output",
      now: fixedNow,
    });
    expect(result).toContain('"command": "npm test"');
  });

  it("truncates output to 512 bytes", () => {
    const longOutput = "x".repeat(2000);
    const result = formatSummaryBlock({
      toolName: "Read",
      toolInput: { path: "big.md" },
      toolOutput: longOutput,
      now: fixedNow,
    });
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThan(1500);
    expect(result).toContain("truncated");
  });

  it("redacts secrets in output", () => {
    const result = formatSummaryBlock({
      toolName: "Bash",
      toolInput: { command: "echo" },
      toolOutput: "API_KEY=sk-abc123456789",
      now: fixedNow,
    });
    expect(result).not.toContain("sk-abc123456789");
    expect(result).toContain("[REDACTED]");
  });
});
