import OpenAI from "openai";
import type { LLMFinishReason, LLMProvider, LLMRequest, LLMResponse, LLMTokenUsage } from "./types.js";
import { LLMConfigError } from "./types.js";

export interface OpenAICompatLLMOptions {
  baseURL: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}

const DEFAULT_MODEL = "llama3.2";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;

export function createOpenAICompatLLM(
  opts: OpenAICompatLLMOptions,
  _client?: Pick<OpenAI, "chat">,
): LLMProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const client = _client ?? new OpenAI({
    apiKey: opts.apiKey ?? "not-required",
    baseURL: opts.baseURL,
  });

  return {
    providerName: "openai-compat",
    modelName: model,
    async chat(request: LLMRequest): Promise<LLMResponse> {
      try {
        const body: Parameters<typeof client.chat.completions.create>[0] = {
          model,
          messages: request.messages,
          max_tokens: request.maxTokens ?? maxTokens,
          temperature: request.temperature ?? temperature,
        };
        if (request.jsonSchema) {
          body.response_format = {
            type: "json_schema",
            json_schema: {
              name: request.jsonSchema.name,
              schema: request.jsonSchema.schema,
              strict: request.jsonSchema.strict ?? true,
            },
          };
        }
        const response = await client.chat.completions.create(body, {
          signal: request.signal,
        });
        return normalizeResponse(response, model);
      } catch (error) {
        if (error instanceof LLMConfigError) throw error;
        throw new LLMConfigError(
          `openai-compat request failed: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    },
  };
}

function normalizeResponse(response: unknown, fallbackModel: string): LLMResponse {
  const record = asRecord(response);
  const choices = Array.isArray(record["choices"]) ? record["choices"] : [];
  const first = choices[0];
  const message = first && typeof first === "object" ? (first as Record<string, unknown>)["message"] : undefined;
  const content =
    message && typeof message === "object" && "content" in message
      ? String((message as Record<string, unknown>)["content"] ?? "")
      : "";
  const finishReason = normalizeFinishReason(
    first && typeof first === "object" ? (first as Record<string, unknown>)["finish_reason"] : undefined,
  );
  const model = typeof record["model"] === "string" ? record["model"] : fallbackModel;
  const result: LLMResponse = { content, model, finishReason, rawProviderName: "openai-compat" };
  const usage = record["usage"];
  if (typeof usage === "object" && usage !== null) {
    const u = usage as Record<string, unknown>;
    if (typeof u["prompt_tokens"] === "number" && typeof u["completion_tokens"] === "number") {
      result.tokensUsed = {
        prompt: u["prompt_tokens"] as number,
        completion: u["completion_tokens"] as number,
        total: typeof u["total_tokens"] === "number" ? (u["total_tokens"] as number) : (u["prompt_tokens"] as number) + (u["completion_tokens"] as number),
      } satisfies LLMTokenUsage;
    }
  }
  return result;
}

function normalizeFinishReason(value: unknown): LLMFinishReason {
  if (value === "stop") return "stop";
  if (value === "length") return "length";
  if (value === "content_filter") return "filter";
  if (value === "tool_calls") return "tool_calls";
  return "other";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LLMConfigError("openai-compat response must be an object");
  }
  return value as Record<string, unknown>;
}
