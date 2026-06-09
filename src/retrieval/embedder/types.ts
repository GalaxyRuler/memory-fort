export type EmbedInputType = "document" | "query";

export interface EmbedRequest {
  texts: string[];
  inputType?: EmbedInputType;
  signal?: AbortSignal;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dim: number;
  inputTokens?: number;
}

export interface Embedder {
  readonly providerName: string;
  readonly modelName: string;
  readonly dim: number;
  embed(request: EmbedRequest): Promise<EmbedResult>;
}

export interface LegacyEmbedClient {
  embed(
    texts: string[],
    opts?: { inputType?: EmbedInputType; signal?: AbortSignal },
  ): Promise<EmbedResult>;
}

export type EmbedClient = Embedder | LegacyEmbedClient;

export interface EmbedderFactory {
  create(config: EmbedderConfig, env: NodeJS.ProcessEnv): Embedder;
}

export type EmbedderProvider = "lexical" | "voyage" | "openai" | "ollama" | "openai-compat";

export interface EmbedderConfig {
  provider: EmbedderProvider;
  model?: string;
  options?: Record<string, unknown>;
  allowInternalHosts?: boolean;
}

export function isEmbedder(value: EmbedClient): value is Embedder {
  return "providerName" in value && typeof value.providerName === "string";
}

export function embedWithClient(
  client: EmbedClient,
  request: EmbedRequest,
): Promise<EmbedResult> {
  if (isEmbedder(client)) return client.embed(request);
  if (request.inputType === undefined && request.signal === undefined) {
    return client.embed(request.texts);
  }
  return client.embed(request.texts, {
    inputType: request.inputType,
    signal: request.signal,
  });
}
