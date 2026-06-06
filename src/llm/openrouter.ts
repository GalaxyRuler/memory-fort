import OpenAI from "openai";
import type {
  LLMFinishReason,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMTokenUsage,
} from "./types.js";

export interface OpenRouterLLMOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  client?: Pick<OpenAI, "chat">;
}

const DEFAULT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function createOpenRouterLLM(opts: OpenRouterLLMOptions): LLMProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const client = opts.client ?? new OpenAI({
    apiKey: opts.apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/GalaxyRuler/memory-fort",
      "X-Title": "Memory Fort",
    },
  });

  return {
    providerName: "openrouter",
    modelName: model,
    async chat(request: LLMRequest): Promise<LLMResponse> {
      const response = await client.chat.completions.create(
        {
          model,
          messages: request.messages,
          max_tokens: request.maxTokens ?? maxTokens,
          temperature: request.temperature ?? temperature,
          ...(request.jsonSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: request.jsonSchema.name,
                    strict: request.jsonSchema.strict ?? true,
                    schema: request.jsonSchema.schema,
                  },
                },
              }
            : {}),
        },
        { signal: request.signal },
      );
      const choice = response.choices[0];
      if (!choice) throw new Error("OpenRouter returned no choices");
      return {
        content: choice.message.content ?? "",
        model: response.model ?? model,
        finishReason: mapFinishReason(choice.finish_reason),
        rawProviderName: "openrouter",
        tokensUsed: mapUsage(response.usage),
      };
    },
  };
}

function mapFinishReason(reason: unknown): LLMFinishReason {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "filter";
  if (reason === "tool_calls") return "tool_calls";
  return "other";
}

function mapUsage(usage: unknown): LLMTokenUsage | undefined {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  if (
    typeof record["prompt_tokens"] !== "number" ||
    typeof record["completion_tokens"] !== "number" ||
    typeof record["total_tokens"] !== "number"
  ) {
    return undefined;
  }
  return {
    prompt: record["prompt_tokens"],
    completion: record["completion_tokens"],
    total: record["total_tokens"],
  };
}
