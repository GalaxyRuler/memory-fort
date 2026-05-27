import OpenAI from "openai";
import type { Embedder, EmbedResult } from "./types.js";

export interface OpenAIEmbedderOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

export class OpenAIEmbedderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OpenAIEmbedderError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

const DEFAULT_MODEL = "text-embedding-3-small";
const DIM_BY_MODEL: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

export function createOpenAIEmbedder(opts: OpenAIEmbedderOptions): Embedder {
  const model = opts.model ?? DEFAULT_MODEL;
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });

  return {
    providerName: "openai",
    modelName: model,
    dim: DIM_BY_MODEL[model] ?? DIM_BY_MODEL[DEFAULT_MODEL]!,
    async embed({ texts, signal }) {
      try {
        const response = await client.embeddings.create(
          { model, input: texts },
          { signal },
        );
        return normalizeOpenAIEmbeddingResponse(response, model, this.dim);
      } catch (error) {
        throw normalizeOpenAIError(error);
      }
    },
  };
}

function normalizeOpenAIEmbeddingResponse(
  response: unknown,
  fallbackModel: string,
  fallbackDim: number,
): EmbedResult {
  const record = asRecord(response, "OpenAI embedding response");
  const data = Array.isArray(record["data"]) ? record["data"] : [];
  const vectors = data.map((item, index) => {
    const embedding = asRecord(item, `OpenAI embedding ${index}`)["embedding"];
    if (
      !Array.isArray(embedding) ||
      !embedding.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new OpenAIEmbedderError(`OpenAI embedding ${index} is missing a numeric vector`);
    }
    return embedding;
  });
  const result: EmbedResult = {
    vectors,
    model: typeof record["model"] === "string" ? record["model"] : fallbackModel,
    dim: vectors[0]?.length ?? fallbackDim,
  };
  const usage = asOptionalRecord(record["usage"]);
  if (typeof usage?.["total_tokens"] === "number") {
    result.inputTokens = usage["total_tokens"];
  }
  return result;
}

function normalizeOpenAIError(error: unknown): OpenAIEmbedderError {
  if (error instanceof OpenAIEmbedderError) return error;
  if (error instanceof Error && error.message.length > 0) {
    return new OpenAIEmbedderError(error.message, error);
  }
  return new OpenAIEmbedderError(String(error), error);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenAIEmbedderError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
