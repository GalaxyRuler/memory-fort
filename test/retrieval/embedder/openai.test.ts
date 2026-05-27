import { describe, expect, it, vi } from "vitest";
import { createOpenAIEmbedder } from "../../../src/retrieval/embedder/openai.js";

const openai = vi.hoisted(() => ({
  constructor: vi.fn(),
  create: vi.fn(),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation((options: unknown) => {
    openai.constructor(options);
    return { embeddings: { create: openai.create } };
  }),
}));

describe("OpenAI embedder", () => {
  it("uses the official SDK and normalizes embedding results", async () => {
    openai.create.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      model: "text-embedding-3-small",
      usage: { total_tokens: 10 },
    });
    const embedder = createOpenAIEmbedder({ apiKey: "test-key" });

    await expect(embedder.embed({ texts: ["a", "b"] })).resolves.toEqual({
      vectors: [[0.1, 0.2], [0.3, 0.4]],
      model: "text-embedding-3-small",
      dim: 2,
      inputTokens: 10,
    });
    expect(openai.constructor).toHaveBeenCalledWith({ apiKey: "test-key", baseURL: undefined });
    expect(openai.create).toHaveBeenCalledWith(
      { model: "text-embedding-3-small", input: ["a", "b"] },
      { signal: undefined },
    );
  });

  it("advertises the configured model dimension", () => {
    expect(createOpenAIEmbedder({
      apiKey: "test-key",
      model: "text-embedding-3-large",
    }).dim).toBe(3072);
  });
});
