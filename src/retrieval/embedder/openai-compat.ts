import OpenAI from "openai";
import type { Embedder, EmbedResult } from "./types.js";
import { OpenAIEmbedderError } from "./openai.js";

export interface OpenAICompatEmbedderOptions {
  baseURL: string;
  model?: string;
  /** Embedding dimension — required because it's model-specific and unknown statically. */
  dim: number;
  apiKey?: string;
}

const DEFAULT_MODEL = "nomic-embed-text";

export function createOpenAICompatEmbedder(
  opts: OpenAICompatEmbedderOptions,
  _client?: Pick<OpenAI, "embeddings">,
): Embedder {
  const model = opts.model ?? DEFAULT_MODEL;
  const dim = opts.dim;
  const client = _client ?? new OpenAI({
    apiKey: opts.apiKey ?? "not-required",
    baseURL: opts.baseURL,
  });

  return {
    providerName: "openai-compat",
    modelName: model,
    dim,
    async embed({ texts, signal }) {
      try {
        const response = await (client.embeddings.create as (
          body: { model: string; input: string[] },
          opts?: { signal?: AbortSignal },
        ) => Promise<unknown>)(
          { model, input: texts },
          signal ? { signal } : undefined,
        );
        return normalizeResponse(response, model, dim);
      } catch (error) {
        if (error instanceof OpenAIEmbedderError) throw error;
        throw new OpenAIEmbedderError(
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
    },
  };
}

function normalizeResponse(response: unknown, fallbackModel: string, fallbackDim: number): EmbedResult {
  const record = asRecord(response);
  const data = Array.isArray(record["data"]) ? record["data"] : [];
  const vectors = data.map((item: unknown, index: number) => {
    const embedding = (asRecord(item))["embedding"];
    if (
      !Array.isArray(embedding) ||
      !embedding.every((v: unknown) => typeof v === "number" && Number.isFinite(v))
    ) {
      throw new OpenAIEmbedderError(`embedding ${index} is missing a numeric vector`);
    }
    return embedding as number[];
  });
  const result: EmbedResult = {
    vectors,
    model: typeof record["model"] === "string" ? record["model"] : fallbackModel,
    dim: vectors[0]?.length ?? fallbackDim,
  };
  const usage = record["usage"];
  if (typeof usage === "object" && usage !== null && "total_tokens" in usage) {
    const totalTokens = (usage as Record<string, unknown>)["total_tokens"];
    if (typeof totalTokens === "number") result.inputTokens = totalTokens;
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenAIEmbedderError("openai-compat embedding response must be an object");
  }
  return value as Record<string, unknown>;
}
