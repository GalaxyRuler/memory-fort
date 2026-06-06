import { afterEach, describe, expect, it, vi } from "vitest";
import { createOllamaEmbedder, OllamaEmbedderError } from "../../../src/retrieval/embedder/ollama.js";

describe("Ollama embedder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("embeds each text through the local Ollama API", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        embedding: body.prompt === "alpha" ? [1, 0, 0] : [0, 1, 0],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchFn);
    const embedder = createOllamaEmbedder({ host: "http://ollama.test", model: "nomic-embed-text" });

    await expect(embedder.embed({ texts: ["alpha", "beta"] })).resolves.toEqual({
      vectors: [[1, 0, 0], [0, 1, 0]],
      model: "nomic-embed-text",
      dim: 3,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "http://ollama.test/api/embeddings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "nomic-embed-text", prompt: "alpha" }),
      }),
    );
  });

  it("surfaces connection failures with the configured host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const embedder = createOllamaEmbedder({ host: "http://missing.test" });

    await expect(embedder.embed({ texts: ["alpha"] })).rejects.toThrow(OllamaEmbedderError);
    await expect(embedder.embed({ texts: ["alpha"] })).rejects.toThrow("OLLAMA_HOST unreachable: http://missing.test");
  });
});
