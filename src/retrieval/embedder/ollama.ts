import type { Embedder, EmbedResult } from "./types.js";

export interface OllamaEmbedderOptions {
  host?: string;
  model?: string;
}

export class OllamaEmbedderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OllamaEmbedderError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "nomic-embed-text";
const DIM_BY_OLLAMA_MODEL: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
};

export function createOllamaEmbedder(opts: OllamaEmbedderOptions = {}): Embedder {
  const host = trimTrailingSlash(opts.host ?? process.env["OLLAMA_HOST"] ?? DEFAULT_HOST);
  const model = opts.model ?? DEFAULT_MODEL;
  const expectedDim = DIM_BY_OLLAMA_MODEL[model] ?? 768;

  return {
    providerName: "ollama",
    modelName: model,
    dim: expectedDim,
    async embed({ texts, signal }) {
      const vectors: number[][] = [];
      for (const text of texts) {
        vectors.push(await embedOne({ host, model, prompt: text, signal }));
      }
      return {
        vectors,
        model,
        dim: vectors[0]?.length ?? expectedDim,
      };
    },
  };
}

async function embedOne(input: {
  host: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<number[]> {
  let response: Response;
  try {
    response = await fetch(`${input.host}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: input.model, prompt: input.prompt }),
      signal: input.signal,
    });
  } catch (error) {
    throw new OllamaEmbedderError(`OLLAMA_HOST unreachable: ${input.host}`, error);
  }

  if (!response.ok) {
    throw new OllamaEmbedderError(
      `Ollama embedding request failed with HTTP ${response.status} at ${input.host}`,
    );
  }

  const parsed = await response.json() as unknown;
  return readEmbedding(parsed);
}

function readEmbedding(value: unknown): number[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OllamaEmbedderError("Ollama embedding response must be an object");
  }
  const embedding = (value as { embedding?: unknown }).embedding;
  if (
    !Array.isArray(embedding) ||
    !embedding.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    throw new OllamaEmbedderError("Ollama embedding response missing numeric embedding");
  }
  return embedding;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
