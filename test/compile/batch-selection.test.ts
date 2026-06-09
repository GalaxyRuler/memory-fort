import { describe, it, expect } from "vitest";
import { scoreSessionByIndexCard } from "../../src/compile/index-card.js";

describe("scoreSessionByIndexCard", () => {
  it("returns higher score when topics overlap wiki page titles", () => {
    const wikiTitles = ["retrieval-pipeline", "bm25", "voyage"];
    const highOverlap = {
      topics: ["retrieval-pipeline", "bm25", "embedding-refresh"],
    };
    const lowOverlap = {
      topics: ["unrelated-topic", "random-stuff"],
    };

    const highScore = scoreSessionByIndexCard(highOverlap.topics, wikiTitles);
    const lowScore = scoreSessionByIndexCard(lowOverlap.topics, wikiTitles);

    expect(highScore).toBeGreaterThan(lowScore);
  });

  it("returns 0 when no topics overlap", () => {
    const score = scoreSessionByIndexCard(
      ["alpha", "beta"],
      ["gamma", "delta"],
    );
    expect(score).toBe(0);
  });

  it("counts each overlap once", () => {
    const score = scoreSessionByIndexCard(
      ["retrieval-pipeline", "retrieval-pipeline"],
      ["retrieval-pipeline"],
    );
    expect(score).toBe(1);
  });
});
