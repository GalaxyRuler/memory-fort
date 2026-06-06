import { LLMConfigError, type LLMFinishReason, type LLMProvider, type LLMRequest, type LLMResponse } from "./types.js";

export interface OllamaLLMOptions {
  host?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "llama3.2";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;

export function createOllamaLLM(opts: OllamaLLMOptions = {}): LLMProvider {
  const host = trimTrailingSlash(opts.host ?? process.env["OLLAMA_HOST"] ?? DEFAULT_HOST);
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;

  return {
    providerName: "ollama",
    modelName: model,
    async chat(request: LLMRequest): Promise<LLMResponse> {
      if (request.jsonSchema) {
        throw new LLMConfigError("structured output not supported for Ollama provider");
      }

      let response: Response;
      try {
        response = await fetch(`${host}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: request.messages,
            stream: false,
            options: {
              temperature: request.temperature ?? temperature,
              num_predict: request.maxTokens ?? maxTokens,
            },
          }),
          signal: request.signal,
        });
      } catch (error) {
        throw new LLMConfigError(`OLLAMA_HOST unreachable: ${host}`, error);
      }

      if (!response.ok) {
        throw new LLMConfigError(
          `Ollama chat request failed with HTTP ${response.status} at ${host}`,
        );
      }

      const parsed = await response.json() as unknown;
      return normalizeOllamaResponse(parsed, model);
    },
  };
}

function normalizeOllamaResponse(value: unknown, fallbackModel: string): LLMResponse {
  const record = asRecord(value, "Ollama chat response");
  const message = asOptionalRecord(record["message"]);
  const content = typeof message?.["content"] === "string" ? message["content"] : "";
  const promptTokens = readNumber(record["prompt_eval_count"]);
  const completionTokens = readNumber(record["eval_count"]);
  return {
    content,
    model: readString(record["model"]) ?? fallbackModel,
    finishReason: mapFinishReason(record["done_reason"]),
    rawProviderName: "ollama",
    tokensUsed: promptTokens !== undefined || completionTokens !== undefined
      ? {
          prompt: promptTokens ?? 0,
          completion: completionTokens ?? 0,
          total: (promptTokens ?? 0) + (completionTokens ?? 0),
        }
      : undefined,
  };
}

function mapFinishReason(reason: unknown): LLMFinishReason {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  return "other";
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LLMConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
