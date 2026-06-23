import { describe, it, expect } from "vitest";
import { detectAutomationKind, AUTOMATION_PROMPT_SIGNATURES } from "../../src/compile/automation-signatures.js";

const SUGGESTION_BODY = [
  "# Overview",
  "",
  "Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: C:\\Projects\\FamTree",
  "",
  "# Rules",
  "Recent Codex threads in this project:",
  "[]",
].join("\n");

function prompt(body: string): string {
  return `## [00:08:12] Prompt\n\n${body}\n`;
}

describe("automation-signatures", () => {
  it("registry is non-empty and every entry has id + regex", () => {
    expect(AUTOMATION_PROMPT_SIGNATURES.length).toBeGreaterThan(0);
    for (const sig of AUTOMATION_PROMPT_SIGNATURES) {
      expect(typeof sig.id).toBe("string");
      expect(sig.re).toBeInstanceOf(RegExp);
    }
  });

  it("flags a pure codex suggestion-generator session", () => {
    expect(detectAutomationKind(prompt(SUGGESTION_BODY))).toBe("codex-suggestion-generator");
  });

  it("returns null when any prompt turn is user-authored", () => {
    const mixed = prompt(SUGGESTION_BODY) + prompt("Add a Supabase migration for the nasab table.");
    expect(detectAutomationKind(mixed)).toBeNull();
  });

  it("returns null when there is no prompt turn at all", () => {
    expect(detectAutomationKind("## [00:00:00] ToolResult\n\nsome output\n")).toBeNull();
  });
});
