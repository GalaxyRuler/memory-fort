import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbedderFromConfig,
  EmbedderConfigError,
  getActiveEmbedderConfig,
  listEmbedderProviders,
} from "../../../src/retrieval/embedder/factory.js";

describe("embedder factory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("rejects internal configured embedder URLs unless the embedder section opts in", () => {
    expect(() => createEmbedderFromConfig(
      {
        provider: "ollama",
        model: "nomic-embed-text",
        options: { host: "http://10.0.0.5:11434" },
      },
      {},
    )).toThrow("OLLAMA host must not target an internal host");

    const local = createEmbedderFromConfig(
      getActiveEmbedderConfig({
        embedder: {
          provider: "ollama",
          model: "nomic-embed-text",
          options: { host: "http://127.0.0.1:11434" },
          allow_internal_hosts: true,
        },
      }),
      {},
    );
    expect(local.providerName).toBe("ollama");
  });

  it("normalizes accepted bare Ollama embedder hosts before runtime use", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ embedding: [0.1, 0.2] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const embedder = createEmbedderFromConfig(
      {
        provider: "ollama",
        model: "nomic-embed-text",
        options: { host: "localhost:11434" },
        allowInternalHosts: true,
      },
      {},
    );

    await embedder.embed({ texts: ["hello"] });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/embeddings",
      expect.any(Object),
    );
  });

  it("rejects scheme-like bare Ollama embedder hosts under internal-host opt-in", () => {
    expect(() => createEmbedderFromConfig(
      {
        provider: "ollama",
        model: "nomic-embed-text",
        options: { host: "ftp:80" },
        allowInternalHosts: true,
      },
      {},
    )).toThrow("OLLAMA host must be an http(s) URL");
  });

  it("rejects userinfo in configured Ollama embedder hosts", () => {
    expect(() => createEmbedderFromConfig(
      {
        provider: "ollama",
        model: "nomic-embed-text",
        options: { host: "http://user:pass@localhost:11434" },
        allowInternalHosts: true,
      },
      {},
    )).toThrow("OLLAMA host must not include URL credentials");
  });

  it("rejects query and fragment parts in configured and env Ollama embedder hosts", () => {
    for (const host of [
      "http://127.0.0.1:11434/?x=1",
      "http://127.0.0.1:11434/#x",
    ]) {
      expect(() => createEmbedderFromConfig(
        {
          provider: "ollama",
          model: "nomic-embed-text",
          options: { host },
          allowInternalHosts: true,
        },
        {},
      ), host).toThrow("OLLAMA host must not include query strings or fragments");

      expect(() => createEmbedderFromConfig(
        { provider: "ollama", model: "nomic-embed-text" },
        { OLLAMA_HOST: host },
      ), host).toThrow("OLLAMA host must not include query strings or fragments");
    }
  });

  it("normalizes accepted bare env Ollama embedder hosts before runtime use", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ embedding: [0.1, 0.2] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const embedder = createEmbedderFromConfig(
      { provider: "ollama", model: "nomic-embed-text" },
      { OLLAMA_HOST: "127.0.0.1:11434" },
    );

    await embedder.embed({ texts: ["hello"] });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.any(Object),
    );
  });

  it("requires the official HTTPS OpenAI embedder endpoint by default", () => {
    for (const baseURL of [
      "http://api.openai.com/v1",
      "https://8.8.8.8/v1",
      "http://8.8.8.8/v1",
      "http://127.0.0.1:8080/v1",
      "http://public-looking.example.test/v1",
      "https://api.openai.com",
      "https://api.openai.com:444/v1",
      "https://user:pass@api.openai.com/v1",
      "https://api.openai.com/v1?x=1",
      "https://api.openai.com/v1#x",
    ]) {
      expect(() => createEmbedderFromConfig(
        {
          provider: "openai",
          model: "text-embedding-3-small",
          options: { baseURL },
        },
        { OPENAI_API_KEY: "set" },
      ), baseURL).toThrow("embedder baseURL must use the official OpenAI HTTPS endpoint");
    }
  });

  it("rejects DNS configured Ollama embedder URLs before runtime", () => {
    for (const host of [
      "http://public-looking.example.test:11434",
      "https://api.openai.com",
      "https://api.voyageai.com",
      "https://openrouter.ai",
    ]) {
      expect(() => createEmbedderFromConfig(
        {
          provider: "ollama",
          model: "nomic-embed-text",
          options: { host },
        },
        {},
      ), host).toThrow("OLLAMA host DNS hostnames are blocked");
    }
  });

  it("allows official OpenAI embedder endpoint DNS", () => {
    const embedder = createEmbedderFromConfig(
      {
        provider: "openai",
        model: "text-embedding-3-small",
        options: { baseURL: "https://api.openai.com/v1" },
      },
      { OPENAI_API_KEY: "set" },
    );

    expect(embedder.providerName).toBe("openai");
  });

  it("allows official OpenAI embedder endpoint with a trailing slash", () => {
    const embedder = createEmbedderFromConfig(
      {
        provider: "openai",
        model: "text-embedding-3-small",
        options: { baseURL: "https://api.openai.com/v1/" },
      },
      { OPENAI_API_KEY: "set" },
    );

    expect(embedder.providerName).toBe("openai");
  });

  it("propagates embedder allow_internal_hosts from config", () => {
    expect(getActiveEmbedderConfig({
      embedder: {
        provider: "ollama",
        model: "nomic-embed-text",
        options: { host: "http://127.0.0.1:11434" },
        allow_internal_hosts: true,
      },
    })).toMatchObject({
      provider: "ollama",
      model: "nomic-embed-text",
      allowInternalHosts: true,
    });
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
      expect.objectContaining({ provider: "openai-compat", requiredEnv: "none", active: false, keyAvailable: true }),
    ]);
  });
});
