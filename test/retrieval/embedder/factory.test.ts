import { describe, expect, it } from "vitest";
import {
  createEmbedderFromConfig,
  EmbedderConfigError,
  getActiveEmbedderConfig,
  listEmbedderProviders,
} from "../../../src/retrieval/embedder/factory.js";

describe("embedder factory", () => {
  it("defaults to Voyage when config is absent", () => {
    expect(getActiveEmbedderConfig({})).toEqual({
      provider: "voyage",
      model: "voyage-4-large",
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
      expect.objectContaining({ provider: "voyage", requiredEnv: "VOYAGE_API_KEY", active: false }),
      expect.objectContaining({ provider: "openai", requiredEnv: "OPENAI_API_KEY", active: true, keyAvailable: true }),
      expect.objectContaining({ provider: "ollama", requiredEnv: "OLLAMA_HOST", active: false }),
    ]);
  });
});
