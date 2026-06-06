export interface OpenRouterCatalogModel {
  id: string;
  default?: boolean;
  free: boolean;
}

export const OPENROUTER_CURATED_MODELS: OpenRouterCatalogModel[] = [
  { id: "openai/gpt-4o-mini", default: true, free: false },
  { id: "openai/gpt-4o", free: false },
  { id: "openai/gpt-4.1-mini", free: false },
  { id: "openai/gpt-4.1", free: false },
  { id: "anthropic/claude-3.5-sonnet", free: false },
  { id: "anthropic/claude-3.5-haiku", free: false },
  { id: "google/gemini-2.0-flash-001", free: false },
  { id: "meta-llama/llama-3.1-70b-instruct", free: false },
  { id: "mistralai/mistral-large", free: false },
  { id: "qwen/qwen-2.5-7b-instruct:free", free: true },
  { id: "meta-llama/llama-3.1-8b-instruct:free", free: true },
  { id: "mistralai/mistral-7b-instruct:free", free: true },
];
