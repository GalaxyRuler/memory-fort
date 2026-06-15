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
    expect(result.strippedByClass["base64-blob"]).toBeGreaterThan(0);
    expect(result.noiseOnly).toBe(true);
  });

  it("strips ANSI build asset tables and marks pure known-noise output noise-only", () => {
    const body = [
      "\u001b[32m✓ built in 812ms\u001b[39m",
      "dist/assets/index-a1b2c3.js    128.44 kB │ gzip: 42.10 kB",
      "dist/assets/style-d4e5f6.css    24.20 kB │ gzip:  6.80 kB",
      "\u001b[2mShell cwd was reset to C:\\Projects\\app\u001b[22m",
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

describe("filter-raw: tool-heavy reduction", () => {
  it("keeps long inline ToolUse command values whole", () => {
    const longCommand = [
      "powershell -NoProfile -Command",
      "\"$ErrorActionPreference = 'Stop';",
      "$script = @'",
      ...Array.from({ length: 20 }, (_, index) => `Write-Output 'compile command slice ${index} ${"x".repeat(24)}'`),
      "'@;",
      "Invoke-Expression $script\"",
    ].join(" ");
    expect(Buffer.byteLength(longCommand, "utf-8")).toBeGreaterThan(300);

    const result = filterRawText(rawTurn("ToolUse: Bash", JSON.stringify({ command: longCommand }, null, 2)));
    const filteredBody = splitTurns(result.filtered)[0]?.body.trim() ?? "";
    const parsed = JSON.parse(filteredBody) as { command: string };

    expect(parsed.command).toBe(longCommand);
    expect(result.filtered).not.toContain("[elided");
    expect(result.noiseOnly).toBe(false);
  });

  it("keeps plain-text ToolUse input sections whole", () => {
    const command = [
      "powershell -NoProfile -Command",
      ...Array.from({ length: 18 }, (_, index) => `"Write-Output plain input command ${index} ${"y".repeat(24)}"`),
    ].join(" ");
    const inputContent = Array.from({ length: 12 }, (_, index) => (
      `plain input file payload ${index} ${"q".repeat(36)}`
    )).join("\n");
    const input = JSON.stringify({ command, content: inputContent }, null, 2);
    expect(Buffer.byteLength(command, "utf-8")).toBeGreaterThan(300);
    expect(Buffer.byteLength(inputContent, "utf-8")).toBeGreaterThan(300);

    const result = filterRawText(rawTurn("ToolUse: Bash", [
      "**Input:**",
      input,
      "",
      "**Output:**",
      "3 passed",
    ].join("\n")));

    expect(result.filtered).toContain("**Input:**");
    expect(result.filtered).toContain(input);
    expect(result.filtered).toContain("3 passed");
    expect(result.noiseOnly).toBe(false);
  });

  it("keeps long ToolResult findings prose whole", () => {
    const findings = [
      "**Findings**",
      "No P0/P1 blockers.",
      "",
      "P2: Keep the CLI confirmation wording intact for operator review.",
      "Recommendation: ship the focused fix after the filtered transcript bench.",
      "Conclusion: this is a fidelity improvement with an accepted reduction trade-off.",
      ...Array.from({ length: 8 }, (_, index) => `Supporting note ${index}: preserve this prose summary for follow-up review.`),
    ].join("\n");
    expect(Buffer.byteLength(findings, "utf-8")).toBeGreaterThan(300);

    const result = filterRawText(rawTurn("ToolResult: toolu_findings", JSON.stringify([
      { type: "text", text: findings },
    ], null, 2)));
    const filteredBody = splitTurns(result.filtered)[0]?.body.trim() ?? "";
    const parsed = JSON.parse(filteredBody) as Array<{ type: string; text: string }>;

    expect(parsed[0]?.text).toBe(findings);
    expect(result.filtered).not.toContain("[elided");
    expect(result.noiseOnly).toBe(false);
  });

  it("keeps prose-marked plain-text ToolUse output runs whole", () => {
    const output = [
      "**Summary**",
      "No P0/P1 blockers were found in the review pass.",
      "Recommendation: retain this operator-facing summary even though it is long.",
      ...Array.from({ length: 12 }, (_, index) => `Review note ${index}: preserve the prose context for later audit.`),
    ].join("\n");
    expect(Buffer.byteLength(output, "utf-8")).toBeGreaterThan(400);

    const result = filterRawText(rawTurn("ToolUse: Bash", [
      "**Input:**",
      "review-tool --format markdown",
      "",
      "**Output:**",
      output,
    ].join("\n")));

    expect(result.filtered).toContain(output);
    expect(result.filtered).not.toContain("[elided");
    expect(result.noiseOnly).toBe(false);
  });

  it("elides ToolResult content file dumps even when they contain prose markers", () => {
    const dump = [
      "**Decision**",
      ...Array.from({ length: 80 }, (_, index) => (
        `Decision record ${index}: this is file content, not an operator findings summary. ${"z".repeat(28)}`
      )),
    ].join("\n");
    expect(Buffer.byteLength(dump, "utf-8")).toBeGreaterThan(3_000);

    const result = filterRawText(rawTurn("ToolResult: toolu_file_dump", JSON.stringify({ content: dump }, null, 2)));
    const filteredBody = splitTurns(result.filtered)[0]?.body.trim() ?? "";
    const parsed = JSON.parse(filteredBody) as { content: string };

    expect(parsed.content).toMatch(/^\[elided \d+ bytes\]$/u);
    expect(result.filtered).not.toContain("Decision record 0");
    expect(result.strippedByClass["json-fat-value"]).toBeGreaterThan(0);
    expect(result.noiseOnly).toBe(true);
  });

  it("elides unparsed plain-output JSON content dumps even when they contain prose markers", () => {
    const dump = [
      "**Decision**",
      ...Array.from({ length: 80 }, (_, index) => (
        `Unparsed file dump ${index}: keep this eligible for output-run elision. ${"w".repeat(32)}`
      )),
    ].join("\n");
    const output = [
      "tool wrapper preface",
      JSON.stringify({ content: dump }, null, 2),
    ].join("\n");

    const result = filterRawText(rawTurn("ToolResult: toolu_plain_dump", output));

    expect(result.filtered).toContain("[elided");
    expect(result.filtered).not.toContain("Unparsed file dump 0");
    expect(result.noiseOnly).toBe(false);
  });

  it("keeps base64 image data elided", () => {
    const base64Image = "A".repeat(2_048);
    const result = filterRawText(rawTurn("ToolResult: toolu_image", JSON.stringify({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: base64Image },
    }, null, 2)));
    const filteredBody = splitTurns(result.filtered)[0]?.body.trim() ?? "";
    const parsed = JSON.parse(filteredBody) as { source: { data: string } };

    expect(parsed.source.data).toMatch(/^\[elided \d+ bytes\]$/u);
    expect(result.filtered).not.toContain(base64Image);
    expect(result.strippedByClass["image-data"]).toBeGreaterThan(0);
  });

  it("prunes claude-code JSON ToolResult text and image data while preserving signal", () => {
    const noSignalLog = Array.from({ length: 70 }, (_, index) => (
      `compile progress row ${String(index).padStart(2, "0")} module cache warmed ${"x".repeat(24)}`
    )).join("\n");
    const base64Image = "A".repeat(2_048);
    const body = JSON.stringify([
      { type: "text", text: noSignalLog },
      { type: "text", text: "error: boom failed" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: base64Image } },
    ], null, 2);
    const result = filterRawText(rawTurn("ToolResult: toolu_x", body));
    const reduction = (result.bytesIn - result.bytesOut) / result.bytesIn;
    const filteredBody = result.filtered.slice(result.filtered.indexOf("\n\n") + 2).trim();

    expect(reduction).toBeGreaterThanOrEqual(0.70);
    expect(result.filtered).not.toContain("compile progress row 00");
    expect(result.filtered).not.toContain(base64Image);
    expect(result.filtered).toContain("[elided");
    expect(result.filtered).toContain("error: boom failed");
    expect(() => JSON.parse(filteredBody)).not.toThrow();
    expect(result.strippedByClass["json-fat-value"]).toBeGreaterThan(0);
    expect(result.strippedByClass["image-data"]).toBeGreaterThan(0);
    expect(result.noiseOnly).toBe(false);
  });

  it("keeps whole-file reduction above 55% for multi-turn claude-code JSON ToolResults", () => {
    const toolResultBody = (turnIndex: number) => JSON.stringify([
      {
        type: "text",
        text: Array.from({ length: 90 }, (_, index) => (
          `claude result progress: turn ${turnIndex} row ${index} cache event ${"z".repeat(42)}`
        )).join("\n"),
      },
      { type: "text", text: turnIndex === 4 ? "error: boom failed" : "3 passed" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "B".repeat(3_500) } },
    ], null, 2);
    const text = [
      rawTurn("Prompt", "Review the compile results and keep the useful failures."),
      ...Array.from({ length: 8 }, (_, index) => rawTurn(`ToolResult: toolu_${index}`, toolResultBody(index))),
      rawTurn("Response", "Kept the useful failures."),
    ].join("\n");
    const result = filterRawText(text);
    const reduction = (result.bytesIn - result.bytesOut) / result.bytesIn;

    expect(result.bytesIn).toBeGreaterThanOrEqual(50_000);
    expect(reduction).toBeGreaterThanOrEqual(0.55);
    expect(result.filtered).toContain("Review the compile results");
    expect(result.filtered).toContain("error: boom failed");
    expect(result.filtered).toContain("3 passed");
    expect(result.filtered).not.toContain("claude result progress: turn 0 row 0");
    expect(result.filtered).not.toContain("B".repeat(3_500));
    expect(result.strippedByClass["json-fat-value"]).toBeGreaterThan(0);
    expect(result.strippedByClass["image-data"]).toBeGreaterThan(0);
    expect(result.noiseOnly).toBe(false);
  });

  it("prunes fenced JSON ToolUse content while preserving tool input fields", () => {
    const largeContent = Array.from({ length: 70 }, (_, index) => (
      `draft content: row ${index} generated prose without filter signal ${"q".repeat(34)}`
    )).join("\n");
    const body = [
      "```json",
      JSON.stringify({
        file_path: "C:\\Projects\\app\\docs\\example.md",
        command: "write_file",
        content: largeContent,
      }, null, 2),
      "```",
    ].join("\n");
    const result = filterRawText(rawTurn("ToolUse: Write", body));
    const reduction = (result.bytesIn - result.bytesOut) / result.bytesIn;
    const fencedJson = result.filtered.match(/```json\n([\s\S]*?)\n```/u)?.[1] ?? "";
    const parsed = JSON.parse(fencedJson) as { file_path: string; command: string; content: string };

    expect(reduction).toBeGreaterThanOrEqual(0.70);
    expect(parsed.file_path).toBe("C:\\Projects\\app\\docs\\example.md");
    expect(parsed.command).toBe("write_file");
    expect(parsed.content).toMatch(/^\[elided \d+ bytes\]$/u);
    expect(result.filtered).not.toContain("draft content: row 0");
    expect(result.strippedByClass["json-fat-value"]).toBeGreaterThan(0);
    expect(result.noiseOnly).toBe(false);
  });

  it("prunes unmarked plain ToolResult output while preserving signal lines", () => {
    const result = filterRawText(rawTurn("ToolResult: toolu_plain", [
      ...Array.from({ length: 80 }, (_, index) => `plain read output row ${index} ${"n".repeat(48)}`),
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "error: boom failed",
      "3 passed",
      ...Array.from({ length: 80 }, (_, index) => `plain read output tail ${index} ${"m".repeat(48)}`),
    ].join("\n")));
    const reduction = (result.bytesIn - result.bytesOut) / result.bytesIn;

    expect(reduction).toBeGreaterThanOrEqual(0.70);
    expect(result.filtered).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(result.filtered).toContain("@@ -1,2 +1,2 @@");
    expect(result.filtered).toContain("error: boom failed");
    expect(result.filtered).toContain("3 passed");
    expect(result.filtered).not.toContain("plain read output row 0");
    expect(result.strippedByClass["tool-output"]).toBeGreaterThan(0);
    expect(result.noiseOnly).toBe(false);
  });

  it("prunes plain-text ToolUse output sections while preserving command input and signal lines", () => {
    const bulkLine = "vite transform chunk with repetitive progress and module timing";
    const plainOutput = [
      ...Array.from({ length: 35 }, (_, index) => `${bulkLine} ${String(index).padStart(2, "0")}`),
      "error: x",
      ...Array.from({ length: 20 }, (_, index) => `${bulkLine} after-signal ${String(index).padStart(2, "0")}`),
      "3 passed",
      ...Array.from({ length: 15 }, (_, index) => `${bulkLine} tail ${String(index).padStart(2, "0")}`),
    ].join("\n");
    const input = JSON.stringify({ command: "npm test -- test/compile/filter-raw.test.ts --reporter=dot" }, null, 2);
    const result = filterRawText(rawTurn("ToolUse: Bash", [
      "**Input:**",
      input,
      "",
      "**Output:**",
      plainOutput,
    ].join("\n")));
    const reduction = (result.bytesIn - result.bytesOut) / result.bytesIn;

    expect(reduction).toBeGreaterThanOrEqual(0.70);
    expect(result.filtered).toContain("npm test -- test/compile/filter-raw.test.ts --reporter=dot");
    expect(result.filtered).toContain("**Output:**");
    expect(result.filtered).toContain("error: x");
    expect(result.filtered).toContain("3 passed");
    expect(result.filtered).not.toContain("repetitive progress and module timing 00");
    expect(result.strippedByClass["tool-output"]).toBeGreaterThan(0);
    expect(result.noiseOnly).toBe(false);
  });

  it("keeps whole-file reduction above 75% for multi-turn plain-text tool outputs", () => {
    const plainToolTurn = (turnIndex: number) => rawTurn("ToolUse: Bash", [
      "**Input:**",
      JSON.stringify({ command: `npm test -- shard-${turnIndex}` }, null, 2),
      "",
      "**Output:**",
      ...Array.from({ length: 120 }, (_, index) => (
        `plain process row ${turnIndex}-${index} module transform timing ${"x".repeat(56)}`
      )),
      turnIndex === 3 ? "error: shard failed once" : "3 passed",
      ...Array.from({ length: 80 }, (_, index) => (
        `plain process tail ${turnIndex}-${index} cache progress ${"y".repeat(60)}`
      )),
    ].join("\n"));
    const text = [
      rawTurn("Prompt", "Please run the compile tests before reporting."),
      ...Array.from({ length: 6 }, (_, index) => plainToolTurn(index)),
      rawTurn("Response", "Done."),
    ].join("\n");
    const result = filterRawText(text);
    const reduction = (result.bytesIn - result.bytesOut) / result.bytesIn;

    expect(result.bytesIn).toBeGreaterThanOrEqual(50_000);
    expect(reduction).toBeGreaterThanOrEqual(0.75);
    expect(result.filtered).toContain("Please run the compile tests before reporting.");
    expect(result.filtered).toContain("npm test -- shard-0");
    expect(result.filtered).toContain("3 passed");
    expect(result.filtered).toContain("error: shard failed once");
    expect(result.filtered).not.toContain("plain process row 0-0");
    expect(result.strippedByClass["tool-output"]).toBeGreaterThan(0);
    expect(result.noiseOnly).toBe(false);
  });

  it("strips at least 55% from a tool-heavy fixture while preserving signal", () => {
    const noisyTurns = Array.from({ length: 40 }, (_, index) => rawTurn("ToolUse: Bash", [
      "\u001b[32m✓ built in 812ms\u001b[39m",
      `dist/assets/index-${String(index).padStart(2, "0")}.js    128.44 kB │ gzip: 42.10 kB`,
      JSON.stringify({
        content: "x".repeat(1_000),
        originalFile: "y".repeat(1_000),
        stderr: "\nShell cwd was reset to C:\\Projects\\app",
      }),
    ].join("\n"))).join("\n");
    const text = [
      noisyTurns,
      rawTurn("Prompt", "Always test before pushing."),
      rawTurn("ToolResult", "error: unknown option '--kill'"),
    ].join("\n");

    const result = filterRawText(text);
    const reduction = (result.bytesIn - result.bytesOut) / result.bytesIn;

    expect(reduction).toBeGreaterThanOrEqual(0.55);
    expect(result.strippedByClass["base64-blob"]).toBeGreaterThan(0);
    expect(result.filtered).toContain("Always test before pushing.");
    expect(result.filtered).toContain("error: unknown option '--kill'");
    expect(result.filtered).not.toContain("Shell cwd was reset");
    expect(result.noiseOnly).toBe(false);
  });
});

function rawTurn(kind: string, body: string): string {
  return `## [12:00:00] ${kind}\n\n${body}\n`;
}
