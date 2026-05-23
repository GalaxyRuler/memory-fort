import { describe, expect, it } from "vitest";
import {
  buildBm25Index,
  scoreBm25,
  tokenize,
} from "../../src/retrieval/bm25.js";

describe("BM25 lexical scorer", () => {
  it("tokenize lowercases and splits on non-alphanumeric runs", () => {
    expect(tokenize("Hello, world! foo-bar")).toEqual([
      "hello",
      "world",
      "foo",
      "bar",
    ]);
  });

  it("tokenize handles Unicode (Arabic + accented)", () => {
    expect(tokenize("voyage AI تذكر déjà")).toEqual([
      "voyage",
      "ai",
      "تذكر",
      "déjà",
    ]);
  });

  it("tokenize returns empty for empty/punctuation-only", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(" ")).toEqual([]);
    expect(tokenize("!!!---")).toEqual([]);
  });

  it("buildBm25Index computes IDF and avgdl correctly", () => {
    const index = buildBm25Index([
      { relPath: "a.md", text: "foo bar baz" },
      { relPath: "b.md", text: "foo qux" },
      { relPath: "c.md", text: "baz quux qaaz" },
    ]);

    expect(index.totalDocs).toBe(3);
    expect(index.avgdl).toBeCloseTo(8 / 3);
    expect(index.idf.get("foo")).toBeCloseTo(
      Math.log((3 - 2 + 0.5) / (2 + 0.5) + 1),
    );
    expect(index.idf.get("qux")).toBeCloseTo(
      Math.log((3 - 1 + 0.5) / (1 + 0.5) + 1),
    );
  });

  it("scoreBm25 ranks exact-match doc highest; deterministic ties", () => {
    const index = buildBm25Index([
      { relPath: "a.md", text: "foo bar baz" },
      { relPath: "b.md", text: "foo foo qux" },
      { relPath: "c.md", text: "qux quux" },
    ]);

    expect(scoreBm25("foo", index).map((score) => score.relPath)).toEqual([
      "b.md",
      "a.md",
    ]);
    expect(scoreBm25("nonexistent", index)).toEqual([]);

    const tiedIndex = buildBm25Index([
      { relPath: "b.md", text: "same term" },
      { relPath: "a.md", text: "same term" },
    ]);

    expect(scoreBm25("same", tiedIndex).map((score) => score.relPath)).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it("scoreBm25 returns empty for query with no corpus tokens", () => {
    const index = buildBm25Index([
      { relPath: "a.md", text: "foo bar" },
      { relPath: "b.md", text: "baz qux" },
    ]);

    expect(scoreBm25("!!!@@@", index)).toEqual([]);
  });
});
