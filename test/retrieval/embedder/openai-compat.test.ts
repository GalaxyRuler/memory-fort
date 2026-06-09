import { describe, it, expect, vi } from "vitest";
import { createOpenAICompatEmbedder } from "../../../src/retrieval/embedder/openai-compat.js";

describe("createOpenAICompatEmbedder", () => {
  it("embeds texts via custom baseURL", async () => {
    const fakeEmbed = vi.fn().mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
      model: "nomic-embed-text",
      usage: { total_tokens: 10 },
    });
    const embedder = createOpenAICompatEmbedder(
      { baseURL: "http://localhost:11434/v1", model: "nomic-embed-text", dim: 3 },
      { embeddings: { create: fakeEmbed } } as never,
    );
    const result = await embedder.embed({ texts: ["hello", "world"] });
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.dim).toBe(3);
    expect(result.model).toBe("nomic-embed-text");
  });

  it("uses dim from options when response omits vector length", async () => {
    const fakeEmbed = vi.fn().mockResolvedValue({
      data: [{ embedding: [1, 2] }],
      model: "custom",
    });
    const embedder = createOpenAICompatEmbedder(
      { baseURL: "http://127.0.0.1:8080/v1", dim: 2 },
      { embeddings: { create: fakeEmbed } } as never,
    );
    const result = await embedder.embed({ texts: ["x"] });
    expect(result.dim).toBe(2);
  });

  it("providerName is openai-compat", () => {
    const embedder = createOpenAICompatEmbedder(
      { baseURL: "http://localhost:11434/v1", dim: 768 },
      { embeddings: { create: vi.fn().mockResolvedValue({ data: [], model: "x" }) } } as never,
    );
    expect(embedder.providerName).toBe("openai-compat");
  });

  it("captures inputTokens from usage", async () => {
    const fakeEmbed = vi.fn().mockResolvedValue({
      data: [{ embedding: [0.1] }],
      model: "m",
      usage: { total_tokens: 42 },
    });
    const embedder = createOpenAICompatEmbedder(
      { baseURL: "http://localhost:11434/v1", dim: 1 },
      { embeddings: { create: fakeEmbed } } as never,
    );
    const result = await embedder.embed({ texts: ["test"] });
    expect(result.inputTokens).toBe(42);
  });

  it("wraps API errors in OpenAIEmbedderError", async () => {
    const fakeEmbed = vi.fn().mockRejectedValue(new Error("connection refused"));
    const embedder = createOpenAICompatEmbedder(
      { baseURL: "http://localhost:11434/v1", dim: 768 },
      { embeddings: { create: fakeEmbed } } as never,
    );
    await expect(embedder.embed({ texts: ["x"] })).rejects.toThrow("connection refused");
  });
});
