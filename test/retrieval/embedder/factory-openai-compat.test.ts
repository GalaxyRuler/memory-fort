import { describe, it, expect } from "vitest";
import { createEmbedderFromConfig, getActiveEmbedderConfig } from "../../../src/retrieval/embedder/factory.js";

describe("embedder factory — openai-compat", () => {
  it("getActiveEmbedderConfig parses openai-compat config", () => {
    const config = {
      embedder: {
        provider: "openai-compat",
        model: "nomic-embed-text",
        options: { baseURL: "http://localhost:11434/v1", dim: 768 },
        allow_internal_hosts: true,
      },
    };
    const result = getActiveEmbedderConfig(config);
    expect(result.provider).toBe("openai-compat");
    expect(result.model).toBe("nomic-embed-text");
    expect(result.options?.["baseURL"]).toBe("http://localhost:11434/v1");
    expect(result.allowInternalHosts).toBe(true);
  });

  it("createEmbedderFromConfig creates openai-compat embedder", () => {
    const config = {
      provider: "openai-compat" as const,
      model: "nomic-embed-text",
      options: { baseURL: "http://localhost:11434/v1", dim: 768 },
      allowInternalHosts: true,
    };
    const embedder = createEmbedderFromConfig(config, {});
    expect(embedder.providerName).toBe("openai-compat");
    expect(embedder.dim).toBe(768);
  });

  it("throws EmbedderConfigError if baseURL missing", () => {
    const config = {
      provider: "openai-compat" as const,
      options: { dim: 768 },
      allowInternalHosts: true,
    };
    expect(() => createEmbedderFromConfig(config, {})).toThrow("baseURL");
  });

  it("throws EmbedderConfigError if dim missing", () => {
    const config = {
      provider: "openai-compat" as const,
      options: { baseURL: "http://localhost:11434/v1" },
      allowInternalHosts: true,
    };
    expect(() => createEmbedderFromConfig(config, {})).toThrow("dim");
  });

  it("throws EmbedderConfigError if localhost used without allow_internal_hosts", () => {
    const config = {
      provider: "openai-compat" as const,
      options: { baseURL: "http://localhost:11434/v1", dim: 768 },
    };
    expect(() => createEmbedderFromConfig(config, {})).toThrow("allow_internal_hosts");
  });
});
