import { describe, expect, it, vi } from "vitest";
import { rerankCandidates } from "../../src/retrieval/rerank.js";
import {
  VoyageUnavailableError,
  type VoyageClient,
} from "../../src/retrieval/voyage-client.js";

describe("Voyage rerank wrapper", () => {
  it("rerankCandidates happy path: calls Voyage and maps indices", async () => {
    const voyageClient: VoyageClient = {
      embed: vi.fn(),
      rerank: vi.fn(async () => ({
        ranked: [
          { index: 2, score: 0.9, document: "doc c" },
          { index: 0, score: 0.5, document: "doc a" },
          { index: 1, score: 0.1, document: "doc b" },
        ],
        model: "rerank-2.5",
      })),
    };

    const result = await rerankCandidates({
      query: "q",
      candidates: [
        { relPath: "a", text: "doc a" },
        { relPath: "b", text: "doc b" },
        { relPath: "c", text: "doc c" },
      ],
      voyageClient,
    });

    expect(voyageClient.rerank).toHaveBeenCalledWith(
      "q",
      ["doc a", "doc b", "doc c"],
      { topK: 3, signal: undefined },
    );
    expect(result.ranked).toEqual([
      { relPath: "c", score: 0.9, originalIndex: 2 },
      { relPath: "a", score: 0.5, originalIndex: 0 },
      { relPath: "b", score: 0.1, originalIndex: 1 },
    ]);
    expect(result.model).toBe("rerank-2.5");
    expect(result.degraded).toBe(false);
  });

  it("rerankCandidates graceful degradation on Voyage error", async () => {
    const voyageClient: VoyageClient = {
      embed: vi.fn(),
      rerank: vi.fn(async () => {
        throw new VoyageUnavailableError("network down");
      }),
    };

    await expect(
      rerankCandidates({
        query: "q",
        candidates: [
          { relPath: "a", text: "doc a" },
          { relPath: "b", text: "doc b" },
          { relPath: "c", text: "doc c" },
        ],
        voyageClient,
      }),
    ).resolves.toMatchObject({
      degraded: true,
      model: "n/a",
      ranked: [
        { relPath: "a", score: 0, originalIndex: 0 },
        { relPath: "b", score: 0, originalIndex: 1 },
        { relPath: "c", score: 0, originalIndex: 2 },
      ],
    });
    const result = await rerankCandidates({
      query: "q",
      candidates: [{ relPath: "a", text: "doc a" }],
      voyageClient,
    });
    expect(result.warning).toContain("voyage rerank failed");
    expect(result.warning).toContain("network down");
  });
});
