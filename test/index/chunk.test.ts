import { describe, expect, it } from "vitest";

import { chunkMarkdown } from "../../src/index/chunk.js";

describe("chunkMarkdown", () => {
  it("tags chunks with heading paths, keeps them under the token budget, and overlaps same-section chunks", () => {
    const md = [
      "# Title",
      "",
      "Intro text.",
      "",
      "## A",
      "",
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet.",
      "",
      "## B",
      "",
      "one two three four five six. seven eight nine ten eleven twelve.",
      "thirteen fourteen fifteen sixteen seventeen eighteen.",
    ].join("\n");

    const chunks = chunkMarkdown(md, { maxTokens: 8, overlapTokens: 2, maxChunkChars: 120 });

    const sectionBChunks = chunks.filter((chunk) => chunk.headingPath === "Title > B");
    expect(chunks.some((chunk) => chunk.headingPath === "Title > A")).toBe(true);
    expect(sectionBChunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.tokenCount <= 8)).toBe(true);
    expect(sectionBChunks[0]?.text).toContain("five six");
    expect(sectionBChunks[1]?.text.startsWith("five six")).toBe(true);
  });

  it("emits UTF-8 byte offsets that slice back to the chunk text", () => {
    const md = "# عنوان\n\nمرحبا بالعالم 😄\n\n## B\n\nalpha بيتا gamma.";
    const source = Buffer.from(md, "utf8");

    const chunks = chunkMarkdown(md, { maxTokens: 6, overlapTokens: 1, maxChunkChars: 80 });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(source.subarray(chunk.byteStart, chunk.byteEnd).toString("utf8")).toBe(chunk.text);
    }
  });

  it("ignores frontmatter and fenced-code headings while preserving wikilinks", () => {
    const md = [
      "---",
      "title: Example",
      "# frontmatter heading",
      "---",
      "",
      "# Title",
      "",
      "See [[Target Page|target]] for details.",
      "",
      "```md",
      "## Not a heading",
      "[[CodeLink]]",
      "```",
      "",
      "## Real",
      "",
      "Real section body.",
    ].join("\n");

    const chunks = chunkMarkdown(md, { maxTokens: 40, overlapTokens: 0, maxChunkChars: 400 });
    const headingPaths = chunks.map((chunk) => chunk.headingPath);

    expect(headingPaths).toContain("Title");
    expect(headingPaths).toContain("Title > Real");
    expect(headingPaths).not.toContain("frontmatter heading");
    expect(headingPaths).not.toContain("Title > Not a heading");

    const titleChunk = chunks.find((chunk) => chunk.headingPath === "Title");
    expect(titleChunk?.text).toContain("[[Target Page|target]]");
    expect(titleChunk?.text).toContain("## Not a heading");
  });

  it("keeps a pathological huge section bounded by maxChunkChars", () => {
    const md = `# Huge\n\n${"x".repeat(50_000)}`;
    const source = Buffer.from(md, "utf8");

    const chunks = chunkMarkdown(md, { maxTokens: 8, overlapTokens: 2, maxChunkChars: 1024 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.text.length))).toBeLessThanOrEqual(1024);
    expect(chunks.every((chunk) => chunk.tokenCount <= 8)).toBe(true);
    for (const chunk of chunks) {
      expect(source.subarray(chunk.byteStart, chunk.byteEnd).toString("utf8")).toBe(chunk.text);
    }
  });

  it("does not split a UTF-8 character when capping an oversized non-ASCII token", () => {
    const md = `# Emoji\n\n${"😄".repeat(16)}`;
    const source = Buffer.from(md, "utf8");

    const chunks = chunkMarkdown(md, { maxTokens: 4, overlapTokens: 0, maxChunkChars: 2 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text).not.toContain("\uFFFD");
      expect(source.subarray(chunk.byteStart, chunk.byteEnd).toString("utf8")).toBe(chunk.text);
    }
  });
});
