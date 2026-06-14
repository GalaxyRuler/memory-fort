import { describe, it, expect } from "vitest";
import { filterRawText, splitTurns } from "../../src/compile/filter-raw.js";

describe("filter-raw: parser handles all turn kinds, unknown=keep", () => {
  it("segments Prompt/Response/Thinking/ToolUse/ToolResult/ToolError/Log/Event/SessionEnd", () => {
    const kinds = ["Prompt", "Response", "Thinking", "ToolUse: Bash", "ToolResult", "ToolError", "Log", "Event", "SessionEnd"];
    const text = "---\ntype: raw-session\n---\n\n" +
      kinds.map((k, i) => `## [12:0${i}:00] ${k}\n\nbody ${k}\n`).join("\n");
    expect(splitTurns(text).map((t) => t.kind)).toEqual(kinds);
    const r = filterRawText(text);
    expect(r.filtered).toContain("body Response");
    expect(r.filtered).toContain("body Thinking");
  });

  it("keeps an unknown turn kind verbatim", () => {
    const text = "## [12:00:00] WeirdKind\n\nimportant content\n";
    expect(filterRawText(text).filtered).toContain("important content");
  });
});

describe("filter-raw: positive-match stripping and conservative noise-only classification", () => {
  it.each([
    ["long git diff", `diff --git a/src/a.ts b/src/a.ts\n@@ -1,3 +1,3 @@\n${"+".repeat(4096)}\n`],
    ["failing vitest trace", "FAIL test/example.test.ts > fails\nAssertionError: expected true to be false\n1 failed | 2 passed\n"],
    ["tsc diagnostic", "src/index.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n"],
    ["spec read", "Read docs/superpowers/plans/2026-06-14-compile-cost-control.md\nTask 2 exact implementation notes\n"],
    ["PR JSON", JSON.stringify({ pull_request: { number: 12, body: "Fixes the compile cost control workflow." } }, null, 2)],
    ["code snippet", "```ts\nexport function important() { return 'signal'; }\n```\n"],
    ["unknown option error", "error: unknown option '--kill'\n"],
    ["commit line", "[main a639b1b] fix(compile): include preferences section in index rebuild\n"],
  ])("keeps %s and never marks it noise-only", (_label, body) => {
    const text = rawTurn("ToolResult", body);
    const result = filterRawText(text);

    expect(result.filtered).toContain(body.trim().slice(0, 80));
    expect(result.noiseOnly).toBe(false);
  });

  it("elides fat JSON file-dump fields and classifies all-noise file dumps", () => {
    const dump = "x".repeat(5_000);
    const text = rawTurn("ToolResult", JSON.stringify({
      content: dump,
      originalFile: dump,
      structuredPatch: dump,
    }));

    const result = filterRawText(text);

    expect(result.filtered).not.toContain(dump);
    expect(result.filtered).toContain("[elided ");
    expect(result.strippedByClass["json-fat-field"]).toBeGreaterThan(0);
    expect(result.noiseOnly).toBe(true);
  });

  it("strips ANSI build asset tables and marks pure known-noise output noise-only", () => {
    const body = [
      "\u001b[32m✓ built in 812ms\u001b[39m",
      "dist/assets/index-a1b2c3.js    128.44 kB │ gzip: 42.10 kB",
      "dist/assets/style-d4e5f6.css    24.20 kB │ gzip:  6.80 kB",
      "\u001b[2mShell cwd was reset to C:\\CodexProjects\\memory-system\u001b[22m",
    ].join("\n");

    const result = filterRawText(rawTurn("ToolResult", body));

    expect(result.filtered).not.toContain("\u001b[32m");
    expect(result.filtered).not.toContain("128.44 kB");
    expect(result.strippedByClass["ansi"]).toBeGreaterThan(0);
    expect(result.strippedByClass["asset-table"]).toBeGreaterThan(0);
    expect(result.noiseOnly).toBe(true);
  });

  it("keeps mixed output with an error line and does not mark it noise-only", () => {
    const body = [
      "dist/assets/index-a1b2c3.js    128.44 kB │ gzip: 42.10 kB",
      "error: unknown option '--kill'",
    ].join("\n");

    const result = filterRawText(rawTurn("ToolResult", body));

    expect(result.filtered).toContain("error: unknown option '--kill'");
    expect(result.noiseOnly).toBe(false);
  });
});

function rawTurn(kind: string, body: string): string {
  return `## [12:00:00] ${kind}\n\n${body}\n`;
}
