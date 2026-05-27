import { loadSearchCorpus } from "../../retrieval/corpus.js";
import { refreshEmbeddings, type RefreshResult } from "../../retrieval/refresh.js";
import {
  createEmbedderFromConfig,
  estimateEmbeddingCostUsd,
  getActiveEmbedderConfig,
  listEmbedderProviders,
  type EmbedderConfig,
  type EmbedderProvider,
  type EmbedderProviderInfo,
} from "../../retrieval/embedder/factory.js";
import type { Embedder } from "../../retrieval/embedder/types.js";
import { loadMemoryConfig, type MemoryConfig } from "../../storage/config.js";
import { memoryRoot as defaultMemoryRoot } from "../../storage/paths.js";

export interface ListEmbeddersOptions {
  configLoader?: () => Promise<MemoryConfig>;
  env?: NodeJS.ProcessEnv;
}

export interface ListEmbeddersResult {
  active: EmbedderConfig;
  providers: EmbedderProviderInfo[];
}

export interface TestEmbedderOptions extends ListEmbeddersOptions {
  provider?: EmbedderProvider;
  embedderFactory?: (config: EmbedderConfig, env: NodeJS.ProcessEnv) => Embedder;
  nowMs?: () => number;
}

export interface TestEmbedderResult {
  exitCode: number;
  provider: string;
  model: string;
  dim: number | null;
  latencyMs: number;
  status: "OK" | "ERROR";
  error?: string;
}

export interface ReindexEmbeddingsOptions extends ListEmbeddersOptions {
  memoryRoot?: string;
  mode: "plan" | "apply";
  embedderFactory?: (config: EmbedderConfig, env: NodeJS.ProcessEnv) => Embedder;
}

export interface ReindexEmbeddingsResult {
  exitCode: number;
  applied: boolean;
  provider: EmbedderProvider;
  model: string;
  documentCount: number;
  tokenEstimate: number;
  estimatedCostUsd: number;
  refresh?: RefreshResult;
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

export async function runListEmbedders(
  opts: ListEmbeddersOptions = {},
): Promise<ListEmbeddersResult> {
  const env = opts.env ?? process.env;
  const config = await (opts.configLoader ?? loadMemoryConfig)();
  const active = getActiveEmbedderConfig(config);
  return {
    active,
    providers: listEmbedderProviders(active, env),
  };
}

export function formatListEmbeddersResult(result: ListEmbeddersResult): string {
  return `${result.providers.map((provider) => {
    const availability = provider.provider === "ollama"
      ? `host=${process.env["OLLAMA_HOST"] ?? "http://localhost:11434"}`
      : provider.keyAvailable ? "key set" : "key missing";
    const state = provider.active
      ? `active, model=${provider.model}, dim=${provider.dim}`
      : `available, ${availability}`;
    return `${provider.provider.padEnd(8)} (${provider.requiredEnv}) ${stateBracket(state)}`;
  }).join("\n")}\n`;
}

export async function runTestEmbedder(
  opts: TestEmbedderOptions = {},
): Promise<TestEmbedderResult> {
  const env = opts.env ?? process.env;
  const config = await (opts.configLoader ?? loadMemoryConfig)();
  const active = getActiveEmbedderConfig(config);
  const selected: EmbedderConfig = opts.provider
    ? { provider: opts.provider, model: undefined }
    : active;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const started = nowMs();

  try {
    const embedder = (opts.embedderFactory ?? createEmbedderFromConfig)(selected, env);
    const response = await embedder.embed({
      texts: ["Memory Fort embedder smoke test"],
      inputType: "query",
    });
    return {
      exitCode: 0,
      provider: embedder.providerName,
      model: response.model,
      dim: response.dim,
      latencyMs: Math.max(0, nowMs() - started),
      status: "OK",
    };
  } catch (error) {
    return {
      exitCode: 1,
      provider: selected.provider,
      model: selected.model ?? "",
      dim: null,
      latencyMs: Math.max(0, nowMs() - started),
      status: "ERROR",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatTestEmbedderResult(result: TestEmbedderResult): string {
  const lines = [
    `Provider: ${result.provider}`,
    `Model: ${result.model}`,
    `Dim: ${result.dim ?? "unknown"}`,
    `Latency: ${result.latencyMs}ms`,
    `Status: ${result.status}`,
  ];
  if (result.error) lines.push(`Error: ${result.error}`);
  return `${lines.join("\n")}\n`;
}

export async function runReindexEmbeddings(
  opts: ReindexEmbeddingsOptions,
): Promise<ReindexEmbeddingsResult> {
  const env = opts.env ?? process.env;
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const config = await (opts.configLoader ?? (() => loadMemoryConfig(root)))();
  const active = getActiveEmbedderConfig(config);
  const corpus = await loadSearchCorpus({ vaultRoot: root, scope: "all" });
  const tokenEstimate = estimateCorpusTokens(corpus.documents.map((document) => document.body));
  const base: ReindexEmbeddingsResult = {
    exitCode: corpus.errors.length > 0 ? 1 : 0,
    applied: false,
    provider: active.provider,
    model: active.model ?? "",
    documentCount: corpus.documents.length,
    tokenEstimate,
    estimatedCostUsd: estimateEmbeddingCostUsd(active.provider, tokenEstimate),
  };

  if (opts.mode === "plan" || corpus.errors.length > 0) return base;

  const embedder = (opts.embedderFactory ?? createEmbedderFromConfig)(active, env);
  const refresh = await refreshEmbeddings({
    memoryRoot: root,
    documents: corpus.documents,
    embedClient: embedder,
  });
  return {
    ...base,
    exitCode: refresh.errors.length > 0 ? 1 : 0,
    applied: true,
    refresh,
  };
}

export function formatReindexEmbeddingsResult(result: ReindexEmbeddingsResult): string {
  const lines = [
    `Mode: ${result.applied ? "apply" : "plan"}`,
    `Provider: ${result.provider}`,
    `Model: ${result.model}`,
    `Documents: ${result.documentCount}`,
    `Estimated tokens: ${result.tokenEstimate}`,
    `Estimated cost: $${result.estimatedCostUsd.toFixed(4)}`,
  ];
  if (result.refresh) {
    lines.push(
      `Embedded: ${result.refresh.embedded}`,
      `Unchanged: ${result.refresh.unchanged}`,
      `Pruned: ${result.refresh.pruned}`,
      `Errors: ${result.refresh.errors.length}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function estimateCorpusTokens(texts: string[]): number {
  return texts.reduce(
    (sum, text) => sum + Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE),
    0,
  );
}

function stateBracket(value: string): string {
  return `[${value}]`;
}
