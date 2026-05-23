import { describe, expect, it } from "vitest";
import { exactBoosts } from "../../src/retrieval/exact.js";

describe("exact lexical boosts", () => {
  it("Filename match boosts score", () => {
    const [boost] = exactBoosts("voyageai", [
      {
        relPath: "wiki/projects/voyageai.md",
        title: "Some Other Title",
        tags: [],
      },
    ]);

    expect(boost?.signals.filenameMatch).toBe(true);
    expect(boost?.score).toBeGreaterThanOrEqual(5);
  });

  it("Title match boosts score", () => {
    const [boost] = exactBoosts("voyage", [
      {
        relPath: "wiki/projects/foo.md",
        title: "Voyage AI tool entry",
        tags: [],
      },
    ]);

    expect(boost?.signals.titleMatch).toBe(true);
    expect(boost?.signals.filenameMatch).toBe(false);
    expect(boost?.score).toBeGreaterThanOrEqual(5);
  });

  it("Tag match (exact, case-insensitive) boosts score", () => {
    const [boost] = exactBoosts("voyage", [
      {
        relPath: "wiki/projects/foo.md",
        title: "X",
        tags: ["embeddings", "Voyage", "retrieval"],
      },
    ]);

    expect(boost?.signals.tagMatch).toBe(true);
    expect(boost?.score).toBeGreaterThanOrEqual(4);
  });

  it("No signals -> score 0, returned only with score > 0 filter", () => {
    expect(
      exactBoosts("voyage", [
        {
          relPath: "wiki/projects/foo.md",
          title: "X",
          tags: ["embeddings"],
        },
      ]),
    ).toEqual([]);
  });
});
