import { loadSearchCorpus } from "../../retrieval/corpus.js";
import { refreshEmbeddings, type RefreshResult } from "../../retrieval/refresh.js";
import { chatWithAudit, readLLMAuditSummary, type LLMAuditSummary } from "../../llm/audit.js";
import {
  createLLMFromConfig,
  getActiveLLMConfig,
  listLLMProviders,
  type LLMConfig,
  type LLMProviderInfo,
  type LLMProviderName,
} from "../../llm/factory.js";
import type { LLMFinishReason, LLMProvider } from "../../llm/types.js";
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

export interface ListLLMsOptions {
  configLoader?: () => Promise<MemoryConfig>;
  env?: NodeJS.ProcessEnv;
}

export interface ListLLMsResult {
  active: LLMConfig | null;
  providers: LLMProviderInfo[];
}

export interface TestLLMOptions extends ListLLMsOptions {
  memoryRoot?: string;
  provider?: LLMProviderName;
  llmFactory?: (config: LLMConfig | null, env: NodeJS.ProcessEnv) => LLMProvider;
  nowMs?: () => number;
}

export interface TestLLMResult {
  exitCode: number;
  provider: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  finishReason: LLMFinishReason | null;
  status: "OK" | "ERROR";
  error?: string;
}

export interface AuditSummaryOptions {
  memoryRoot?: string;
  days?: number;
  now?: Date;
  auditWriter?: () => Promise<void>;
}

export interface AuditSummaryResult extends LLMAuditSummary {
  exitCode: number;
  days: number;
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

export async function runListLLMs(opts: ListLLMsOptions = {}): Promise<ListLLMsResult> {
  const env = opts.env ?? process.env;
  const config = await (opts.configLoader ?? loadMemoryConfig)();
  const active = getActiveLLMConfig(config);
  return {
    active,
    providers: listLLMProviders(active, env),
  };
}

export function formatListLLMsResult(result: ListLLMsResult): string {
  return `${result.providers.map((provider) => {
    const availability = provider.provider === "ollama"
      ? `host=${process.env["OLLAMA_HOST"] ?? "http://localhost:11434"}`
      : provider.keyAvailable ? "key set" : "key missing";
    const state = provider.active
      ? `active, model=${provider.model}`
      : `available, ${availability}`;
    return `${provider.provider.padEnd(10)} (${provider.requiredEnv}) ${stateBracket(state)}`;
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

export async function runTestLLM(opts: TestLLMOptions = {}): Promise<TestLLMResult> {
  const env = opts.env ?? process.env;
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const config = await (opts.configLoader ?? (() => loadMemoryConfig(root)))();
  const active = getActiveLLMConfig(config);
  const selected: LLMConfig | null = opts.provider ? { provider: opts.provider } : active;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const started = nowMs();

  try {
    const llm = (opts.llmFactory ?? createLLMFromConfig)(selected, env);
    const response = await chatWithAudit({
      llm,
      vaultRoot: root,
      consumer: "provider-test",
      request: {
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
        maxTokens: 16,
        temperature: 0,
      },
    });
    return {
      exitCode: 0,
      provider: llm.providerName,
      model: response.model,
      tokensIn: response.tokensUsed?.prompt ?? null,
      tokensOut: response.tokensUsed?.completion ?? null,
      latencyMs: Math.max(0, nowMs() - started),
      finishReason: response.finishReason,
      status: "OK",
    };
  } catch (error) {
    return {
      exitCode: 1,
      provider: selected?.provider ?? "",
      model: selected?.model ?? "",
      tokensIn: null,
      tokensOut: null,
      latencyMs: Math.max(0, nowMs() - started),
      finishReason: null,
      status: "ERROR",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatTestLLMResult(result: TestLLMResult): string {
  const lines = [
    `Provider: ${result.provider}`,
    `Model: ${result.model}`,
    `Tokens: ${result.tokensIn ?? "unknown"}/${result.tokensOut ?? "unknown"}`,
    `Latency: ${result.latencyMs}ms`,
    `Finish: ${result.finishReason ?? "unknown"}`,
    `Status: ${result.status}`,
  ];
  if (result.error) lines.push(`Error: ${result.error}`);
  return `${lines.join("\n")}\n`;
}

export async function runAuditSummary(
  opts: AuditSummaryOptions = {},
): Promise<AuditSummaryResult> {
  if (opts.auditWriter) await opts.auditWriter();
  const days = opts.days ?? 7;
  const summary = await readLLMAuditSummary(opts.memoryRoot ?? defaultMemoryRoot(), {
    days,
    now: opts.now,
  });
  return {
    ...summary,
    exitCode: 0,
    days,
  };
}

export function formatAuditSummaryResult(result: AuditSummaryResult): string {
  const lines = [
    `Window: ${result.days} day${result.days === 1 ? "" : "s"}`,
    `Total calls: ${result.totalCalls}`,
    `Total cost: $${result.totalCostUsd.toFixed(4)}`,
  ];
  if (result.byConsumer.length > 0) {
    lines.push(
      "",
      "By consumer:",
      ...result.byConsumer.map((item) =>
        `  ${item.consumer}: ${item.calls} call${item.calls === 1 ? "" : "s"}, $${item.costUsd.toFixed(4)}`
      ),
    );
  }
  if (result.byProviderModel.length > 0) {
    lines.push(
      "",
      "By provider/model:",
      ...result.byProviderModel.map((item) =>
        `  ${item.provider}/${item.model}: ${item.calls} call${item.calls === 1 ? "" : "s"}, tokens ${item.tokensIn}/${item.tokensOut}, $${item.costUsd.toFixed(4)}`
      ),
    );
  }
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
