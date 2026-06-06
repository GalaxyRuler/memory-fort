import { describe, expect, it } from "vitest";
import {
  createEmbedderFromConfig,
  EmbedderConfigError,
  getActiveEmbedderConfig,
  listEmbedderProviders,
} from "../../../src/retrieval/embedder/factory.js";

describe("embedder factory", () => {
  it("defaults to lexical retrieval when config is absent", () => {
    expect(getActiveEmbedderConfig({})).toEqual({
      provider: "lexical",
      model: "lexical",
    });
  });

  it("defaults to lexical retrieval when embedder config has no provider", () => {
    expect(getActiveEmbedderConfig({ embedder: {} })).toEqual({
      provider: "lexical",
      model: "lexical",
    });
  });

  it("reads embedder config before legacy embedding config", () => {
    expect(getActiveEmbedderConfig({
      embedder: { provider: "ollama", model: "mxbai-embed-large" },
      embedding: { provider: "voyage", model: "voyage-4-large" },
    })).toEqual({
      provider: "ollama",
      model: "mxbai-embed-large",
    });
  });

  it("falls back to legacy embedding config", () => {
    expect(getActiveEmbedderConfig({
      embedding: { provider: "openai", model: "text-embedding-3-large" },
    })).toEqual({
      provider: "openai",
      model: "text-embedding-3-large",
    });
  });

  it("rejects unknown providers", () => {
    expect(() => getActiveEmbedderConfig({
      embedder: { provider: "cohere" },
    })).toThrow(EmbedderConfigError);
  });

  it("requires env API keys for cloud providers", () => {
    expect(() => createEmbedderFromConfig(
      { provider: "voyage", model: "voyage-4-large" },
      {},
    )).toThrow("VOYAGE_API_KEY not set");
    expect(() => createEmbedderFromConfig(
      { provider: "openai", model: "text-embedding-3-small" },
      {},
    )).toThrow("OPENAI_API_KEY not set");
  });

  it("creates the keyless lexical embedder without an API key", async () => {
    const embedder = createEmbedderFromConfig(
      { provider: "lexical", model: "lexical" },
      {},
    );

    await expect(embedder.embed({ texts: ["local search"] })).resolves.toEqual({
      vectors: [],
      model: "lexical",
      dim: 0,
    });
    expect(embedder.providerName).toBe("lexical");
    expect(embedder.modelName).toBe("lexical");
    expect(embedder.dim).toBe(0);
  });

  it("creates Ollama without an API key", () => {
    const embedder = createEmbedderFromConfig(
      { provider: "ollama", model: "nomic-embed-text" },
      {},
    );

    expect(embedder.providerName).toBe("ollama");
    expect(embedder.modelName).toBe("nomic-embed-text");
    expect(embedder.dim).toBe(768);
  });

  it("lists provider metadata and active status", () => {
    expect(listEmbedderProviders(
      { provider: "openai", model: "text-embedding-3-small" },
      { OPENAI_API_KEY: "set" },
    )).toEqual([
      expect.objectContaining({ provider: "lexical", requiredEnv: "none", active: false, keyAvailable: true }),
      expect.objectContaining({ provider: "voyage", requiredEnv: "VOYAGE_API_KEY", active: false }),
      expect.objectContaining({ provider: "openai", requiredEnv: "OPENAI_API_KEY", active: true, keyAvailable: true }),
      expect.objectContaining({ provider: "ollama", requiredEnv: "OLLAMA_HOST", active: false }),
    ]);
  });
});
