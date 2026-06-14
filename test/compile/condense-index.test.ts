import { describe, expect, it } from "vitest";
import { condenseIndex } from "../../src/compile/condense-index.js";

describe("condenseIndex", () => {
  it("keeps section headers and every page link while reducing realistic index descriptions", () => {
    const entries = Array.from({ length: 40 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return `- [Project ${number}](wiki/projects/project-${number}.md) - ${"Detailed compile summary with deduplication cues and routing context. ".repeat(2)}`;
    });
    const indexText = ["# Memory Index", "", "## Projects", "", ...entries, ""].join("\n");

    const result = condenseIndex(indexText, { descChars: 50, maxBytes: 32_000 });

    expect(result.text).toContain("## Projects");
    for (let index = 1; index <= 40; index += 1) {
      const number = String(index).padStart(2, "0");
      expect(result.text).toContain(`[Project ${number}](wiki/projects/project-${number}.md)`);
    }
    expect(result.bytesOut).toBeLessThanOrEqual(result.bytesIn * 0.6);
    expect(result.text).not.toContain("routing context. Detailed");
  });

  it("truncates long descriptions to the requested character count plus ellipsis", () => {
    const result = condenseIndex(
      "## Projects\n\n- [Alpha](wiki/projects/alpha.md) - 12345678901234567890123456789012345678901234567890tail\n",
      { descChars: 50, maxBytes: 32_000 },
    );

    expect(result.text).toContain(
      "- [Alpha](wiki/projects/alpha.md) - 12345678901234567890123456789012345678901234567890...",
    );
    expect(result.text).not.toContain("tail");
  });

  it("drops trailing entries when the condensed index exceeds the byte cap and keeps section headers", () => {
    const result = condenseIndex(
      [
        "# Memory Index",
        "",
        "## Projects",
        "- [Alpha](wiki/projects/alpha.md) - Description one",
        "- [Beta](wiki/projects/beta.md) - Description two",
        "## Lessons",
        "- [Gamma](wiki/lessons/gamma.md) - Description three",
        "- [Delta](wiki/lessons/delta.md) - Description four",
        "",
      ].join("\n"),
      { descChars: 12, maxBytes: 180 },
    );

    expect(result.text).toContain("## Projects");
    expect(result.text).toContain("## Lessons");
    expect(result.text).toContain("[Alpha](wiki/projects/alpha.md)");
    expect(result.text).not.toContain("[Delta](wiki/lessons/delta.md)");
    expect(result.text).toContain("> [index truncated: ");
    expect(result.bytesOut).toBeLessThanOrEqual(180);
  });

  it("passes non-entry lines through unchanged", () => {
    const indexText = [
      "# Memory Index",
      "",
      "No curated pages yet.",
      "- not a markdown index entry - keep this text",
      "",
    ].join("\n");

    expect(condenseIndex(indexText, { descChars: 50, maxBytes: 32_000 }).text).toBe(indexText);
  });
});
