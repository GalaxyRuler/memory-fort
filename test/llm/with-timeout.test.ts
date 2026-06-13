import { describe, expect, it } from "vitest";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/llm/types.js";
import { LLMTimeoutError, withLLMTimeout } from "../../src/llm/with-timeout.js";

function providerThat(chat: (request: LLMRequest) => Promise<LLMResponse>): LLMProvider {
  return { providerName: "fake", modelName: "fake-model", chat };
}

const RESPONSE: LLMResponse = {
  content: "ok",
  model: "fake-model",
  finishReason: "stop",
  rawProviderName: "fake",
};

describe("withLLMTimeout", () => {
  it("passes through a fast response", async () => {
    const wrapped = withLLMTimeout(providerThat(async () => RESPONSE), 1_000);
    await expect(wrapped.chat({ messages: [] })).resolves.toEqual(RESPONSE);
  });

  it("throws LLMTimeoutError when the provider exceeds the deadline", async () => {
    const wrapped = withLLMTimeout(
      providerThat(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
          }),
      ),
      50,
    );
    await expect(wrapped.chat({ messages: [] })).rejects.toBeInstanceOf(LLMTimeoutError);
  });

  it("honors a caller-supplied abort signal", async () => {
    const controller = new AbortController();
    const wrapped = withLLMTimeout(
      providerThat(
        (request) =>
          new Promise((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(new Error("caller aborted")), { once: true });
          }),
      ),
      10_000,
    );
    const pending = wrapped.chat({ messages: [], signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("caller aborted");
  });
});
