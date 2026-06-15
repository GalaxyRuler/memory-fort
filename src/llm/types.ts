export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  jsonSchema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export type LLMFinishReason = "stop" | "length" | "filter" | "tool_calls" | "error" | "other";

export interface LLMTokenUsage {
  prompt: number;
  completion: number;
  total: number;
  costUsd?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  finishReason: LLMFinishReason;
  rawProviderName: string;
  tokensUsed?: LLMTokenUsage;
}

export interface LLMProvider {
  readonly providerName: string;
  readonly modelName: string;
  chat(request: LLMRequest): Promise<LLMResponse>;
}

export class LLMDisabledError extends Error {
  constructor(message = "LLM access disabled by MEMORY_LLM_DISABLED=true") {
    super(message);
    this.name = "LLMDisabledError";
  }
}

export class LLMConfigError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LLMConfigError";
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}
