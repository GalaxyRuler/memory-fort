import type { LLMProvider, LLMRequest, LLMResponse } from "./types.js";

export const DEFAULT_LLM_TIMEOUT_MS = 300_000;

export class LLMTimeoutError extends Error {
  constructor(timeoutMs: number, model: string) {
    super(`LLM call timed out after ${timeoutMs}ms (model ${model})`);
    this.name = "LLMTimeoutError";
  }
}

export function withLLMTimeout(
  provider: LLMProvider,
  timeoutMs: number = DEFAULT_LLM_TIMEOUT_MS,
): LLMProvider {
  return {
    providerName: provider.providerName,
    modelName: provider.modelName,
    async chat(request: LLMRequest): Promise<LLMResponse> {
      const controller = new AbortController();
      const upstream = request.signal;
      const onUpstreamAbort = () => controller.abort(upstream?.reason);
      if (upstream?.aborted) {
        controller.abort(upstream.reason);
      } else {
        upstream?.addEventListener("abort", onUpstreamAbort, { once: true });
      }
      const timeoutError = new LLMTimeoutError(timeoutMs, provider.modelName);
      const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
      try {
        return await provider.chat({ ...request, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason === timeoutError) {
          throw timeoutError;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        upstream?.removeEventListener("abort", onUpstreamAbort);
      }
    },
  };
}
