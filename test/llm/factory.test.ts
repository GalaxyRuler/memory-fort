import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLLMFromConfig,
  getActiveLLMConfig,
  listLLMProviders,
} from "../../src/llm/factory.js";
import { LLMConfigError, LLMDisabledError } from "../../src/llm/types.js";

describe("LLM factory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null active config when llm section is absent", () => {
    expect(getActiveLLMConfig({})).toBeNull();
  });

  it("reads llm provider config", () => {
    expect(getActiveLLMConfig({
      llm: {
        provider: "openrouter",
        model: "anthropic/claude-3.5-sonnet",
        max_tokens: 1024,
        temperature: 0.1,
      },
    })).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      max_tokens: 1024,
      temperature: 0.1,
    });
  });

  it("propagates llm allow_internal_hosts from config", () => {
    expect(getActiveLLMConfig({
      llm: {
        provider: "ollama",
        model: "llama3.2",
        options: { host: "http://127.0.0.1:11434" },
        allow_internal_hosts: true,
      },
    })).toMatchObject({
      provider: "ollama",
      model: "llama3.2",
      allowInternalHosts: true,
    });
  });

  it("throws clear errors for missing config, missing key, and kill switch", () => {
    expect(() => createLLMFromConfig(null, {})).toThrow("no `llm:` section");
    expect(() => createLLMFromConfig({ provider: "openrouter" }, {}))
      .toThrow("OPENROUTER_API_KEY not set");
    expect(() => createLLMFromConfig(
      { provider: "ollama" },
      { MEMORY_LLM_DISABLED: "true" },
    )).toThrow(LLMDisabledError);
  });

  it("creates Ollama without a key", () => {
    const llm = createLLMFromConfig({ provider: "ollama", model: "llama3.2" }, {});

    expect(llm.providerName).toBe("ollama");
    expect(llm.modelName).toBe("llama3.2");
  });

  it("keeps operator-controlled env Ollama hosts usable", () => {
    const llm = createLLMFromConfig(
      { provider: "ollama", model: "llama3.2" },
      { OLLAMA_HOST: "http://localhost.:11434" },
    );

    expect(llm.providerName).toBe("ollama");
  });

  it("rejects internal configured Ollama LLM hosts unless llm section opts in", () => {
    expect(() => createLLMFromConfig(
      {
        provider: "ollama",
        model: "llama3.2",
        options: { host: "http://localhost.:11434" },
      },
      {},
    )).toThrow("OLLAMA host must not target an internal host");

    const local = createLLMFromConfig(
      getActiveLLMConfig({
        llm: {
          provider: "ollama",
          model: "llama3.2",
          options: { host: "http://127.0.0.1:11434" },
          allow_internal_hosts: true,
        },
      }),
      {},
    );
    expect(local.providerName).toBe("ollama");
  });

  it("normalizes accepted bare Ollama LLM hosts before runtime use", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        message: { content: "ok" },
        model: "llama3.2",
        done_reason: "stop",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const llm = createLLMFromConfig(
      {
        provider: "ollama",
        model: "llama3.2",
        options: { host: "ollama:11434" },
        allowInternalHosts: true,
      },
      {},
    );

    await llm.chat({ messages: [{ role: "user", content: "hello" }] });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://ollama:11434/api/chat",
      expect.any(Object),
    );
  });

  it("rejects scheme-like bare Ollama LLM hosts under internal-host opt-in", () => {
    expect(() => createLLMFromConfig(
      {
        provider: "ollama",
        model: "llama3.2",
        options: { host: "ftp:80" },
        allowInternalHosts: true,
      },
      {},
    )).toThrow("OLLAMA host must be an http(s) URL");
  });

  it("rejects userinfo in configured Ollama LLM hosts", () => {
    expect(() => createLLMFromConfig(
      {
        provider: "ollama",
        model: "llama3.2",
        options: { host: "http://user:pass@localhost:11434" },
        allowInternalHosts: true,
      },
      {},
    )).toThrow("OLLAMA host must not include URL credentials");
  });

  it("rejects query and fragment parts in configured and env Ollama LLM hosts", () => {
    for (const host of [
      "http://127.0.0.1:11434/?x=1",
      "http://127.0.0.1:11434/#x",
    ]) {
      expect(() => createLLMFromConfig(
        {
          provider: "ollama",
          model: "llama3.2",
          options: { host },
          allowInternalHosts: true,
        },
        {},
      ), host).toThrow("OLLAMA host must not include query strings or fragments");

      expect(() => createLLMFromConfig(
        { provider: "ollama", model: "llama3.2" },
        { OLLAMA_HOST: host },
      ), host).toThrow("OLLAMA host must not include query strings or fragments");
    }
  });

  it("normalizes accepted bare env Ollama LLM hosts before runtime use", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        message: { content: "ok" },
        model: "llama3.2",
        done_reason: "stop",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const llm = createLLMFromConfig(
      { provider: "ollama", model: "llama3.2" },
      { OLLAMA_HOST: "127.0.0.1:11434" },
    );

    await llm.chat({ messages: [{ role: "user", content: "hello" }] });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.any(Object),
    );
  });

  it("rejects DNS configured Ollama LLM hosts before runtime", () => {
    for (const host of [
      "http://public-looking.example.test:11434",
      "https://api.openai.com",
      "https://api.voyageai.com",
      "https://openrouter.ai",
    ]) {
      expect(() => createLLMFromConfig(
        {
          provider: "ollama",
          model: "llama3.2",
          options: { host },
        },
        {},
      ), host).toThrow("OLLAMA host DNS hostnames are blocked");
    }
  });

  it("rejects unknown llm providers", () => {
    expect(() => getActiveLLMConfig({
      llm: { provider: "anthropic" },
    })).toThrow(LLMConfigError);
  });

  it("lists provider metadata and active status", () => {
    expect(listLLMProviders(
      { provider: "ollama", model: "llama3.2" },
      { OLLAMA_HOST: "http://localhost:11434" },
    )).toEqual([
      expect.objectContaining({ provider: "openrouter", requiredEnv: "OPENROUTER_API_KEY", active: false }),
      expect.objectContaining({ provider: "ollama", requiredEnv: "OLLAMA_HOST", active: true, keyAvailable: true }),
      expect.objectContaining({ provider: "openai-compat", requiredEnv: "none", active: false, keyAvailable: true }),
    ]);
  });
});
