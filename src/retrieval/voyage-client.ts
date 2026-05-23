import { createRequire } from "node:module";
import { loadMemoryConfig } from "../storage/config.js";

export interface VoyageClientOptions {
  apiKey: string;
  embedModel?: string;
  rerankModel?: string;
  outputDimension?: number;
}

export interface EmbedResponse {
  vectors: number[][];
  model: string;
  dim: number;
  inputTokens?: number;
}

export interface RerankResponse {
  ranked: Array<{ index: number; score: number; document: string }>;
  model: string;
}

export interface VoyageClient {
  embed(
    texts: string[],
    opts?: { inputType?: "document" | "query"; signal?: AbortSignal },
  ): Promise<EmbedResponse>;
  rerank(
    query: string,
    documents: string[],
    opts?: { topK?: number; signal?: AbortSignal },
  ): Promise<RerankResponse>;
}

export class VoyageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export class VoyageUnavailableError extends VoyageError {}
export class VoyageRateLimitedError extends VoyageError {}
export class VoyageTimeoutError extends VoyageError {}

type VoyageSdkClient = {
  embed(request: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
  rerank(request: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
};

type VoyageSdkConstructor = new (options?: { apiKey?: string }) => VoyageSdkClient;

type RequestOptions = {
  timeoutInSeconds: number;
  abortSignal?: AbortSignal;
};

const DEFAULT_EMBED_MODEL = "voyage-4-large";
const DEFAULT_RERANK_MODEL = "rerank-2.5";
const DEFAULT_OUTPUT_DIMENSION = 2048;
const REQUEST_TIMEOUT_SECONDS = 60;
const require = createRequire(import.meta.url);

export function makeVoyageClient(opts: VoyageClientOptions): VoyageClient {
  const embedModel = opts.embedModel ?? DEFAULT_EMBED_MODEL;
  const rerankModel = opts.rerankModel ?? DEFAULT_RERANK_MODEL;
  const outputDimension = opts.outputDimension ?? DEFAULT_OUTPUT_DIMENSION;
  const SdkVoyageAIClient = loadVoyageSdkConstructor();
  const sdk = new SdkVoyageAIClient({
    apiKey: opts.apiKey,
  });

  return {
    async embed(texts, embedOpts) {
      const request = {
        input: texts,
        model: embedModel,
        inputType: embedOpts?.inputType ?? "document",
        outputDimension,
      };
      try {
        const response = await withAbort(
          sdk.embed(request, requestOptions(embedOpts?.signal)),
          embedOpts?.signal,
        );
        return normalizeEmbedResponse(response, embedModel, outputDimension);
      } catch (error) {
        throw normalizeVoyageError(error, embedOpts?.signal);
      }
    },

    async rerank(query, documents, rerankOpts) {
      const request: Record<string, unknown> = {
        query,
        documents,
        model: rerankModel,
        returnDocuments: true,
      };
      if (rerankOpts?.topK !== undefined) request.topK = rerankOpts.topK;

      try {
        const response = await withAbort(
          sdk.rerank(request, requestOptions(rerankOpts?.signal)),
          rerankOpts?.signal,
        );
        return normalizeRerankResponse(response, documents, rerankModel);
      } catch (error) {
        throw normalizeVoyageError(error, rerankOpts?.signal);
      }
    },
  };
}

export async function resolveVoyageApiKey(memoryRoot?: string): Promise<string> {
  const envKey = process.env["VOYAGE_API_KEY"]?.trim();
  if (envKey) return envKey;

  const config = await loadMemoryConfig(memoryRoot);
  const configKey = config.voyage?.api_key?.trim();
  if (configKey) return configKey;

  throw new VoyageUnavailableError("VOYAGE_API_KEY not set in env or config.yaml");
}

function loadVoyageSdkConstructor(): VoyageSdkConstructor {
  const module = require("voyageai") as { VoyageAIClient?: unknown };
  if (typeof module.VoyageAIClient !== "function") {
    throw new VoyageUnavailableError("voyageai SDK did not export VoyageAIClient");
  }
  return module.VoyageAIClient as VoyageSdkConstructor;
}

function requestOptions(signal?: AbortSignal): RequestOptions {
  const options: RequestOptions = { timeoutInSeconds: REQUEST_TIMEOUT_SECONDS };
  if (signal) options.abortSignal = signal;
  return options;
}

async function withAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    throw new VoyageTimeoutError("Voyage request aborted");
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new VoyageTimeoutError("Voyage request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function normalizeEmbedResponse(
  response: unknown,
  fallbackModel: string,
  fallbackDim: number,
): EmbedResponse {
  const record = asRecord(response, "embed response");
  const data = Array.isArray(record.data) ? record.data : [];
  const vectors = data.map((item, index) => {
    const embedding = asRecord(item, `embedding ${index}`).embedding;
    if (
      !Array.isArray(embedding) ||
      !embedding.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new VoyageError(`embedding ${index} is missing a numeric vector`);
    }
    return embedding;
  });
  const result: EmbedResponse = {
    vectors,
    model: typeof record.model === "string" ? record.model : fallbackModel,
    dim: vectors[0]?.length ?? fallbackDim,
  };
  const usage = asOptionalRecord(record.usage);
  if (typeof usage?.totalTokens === "number") {
    result.inputTokens = usage.totalTokens;
  }
  return result;
}

function normalizeRerankResponse(
  response: unknown,
  documents: string[],
  fallbackModel: string,
): RerankResponse {
  const record = asRecord(response, "rerank response");
  const data = Array.isArray(record.data) ? record.data : [];
  return {
    ranked: data.map((item, fallbackIndex) => {
      const ranked = asRecord(item, `rerank item ${fallbackIndex}`);
      const index =
        typeof ranked.index === "number" && Number.isInteger(ranked.index)
          ? ranked.index
          : fallbackIndex;
      const score =
        typeof ranked.relevanceScore === "number"
          ? ranked.relevanceScore
          : typeof ranked.score === "number"
            ? ranked.score
            : 0;
      return {
        index,
        score,
        document:
          typeof ranked.document === "string" ? ranked.document : documents[index] ?? "",
      };
    }),
    model: typeof record.model === "string" ? record.model : fallbackModel,
  };
}

function normalizeVoyageError(error: unknown, signal?: AbortSignal): VoyageError {
  if (error instanceof VoyageError) return error;
  if (signal?.aborted || isAbortError(error)) {
    return new VoyageTimeoutError("Voyage request aborted", error);
  }

  const status = statusCode(error);
  const message = errorMessage(error);
  if (status === 429) return new VoyageRateLimitedError(message, error);
  if (status === 401 || status === 403 || (status !== undefined && status >= 500)) {
    return new VoyageUnavailableError(message, error);
  }
  if (isNetworkError(error)) return new VoyageUnavailableError(message, error);
  return new VoyageError(message, error);
}

function statusCode(error: unknown): number | undefined {
  const record = asOptionalRecord(error);
  const status = record?.status ?? record?.statusCode ?? record?.code;
  if (typeof status === "number") return status;
  if (typeof status === "string" && /^\d+$/.test(status)) return Number(status);

  const response = asOptionalRecord(record?.response);
  if (typeof response?.status === "number") return response.status;
  return undefined;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError";
}

function isNetworkError(error: unknown): boolean {
  const record = asOptionalRecord(error);
  const code = record?.code;
  return (
    (typeof code === "string" &&
      /^(ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)$/.test(code)) ||
    (error instanceof Error && /fetch failed|network/i.test(error.message))
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VoyageError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
