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
