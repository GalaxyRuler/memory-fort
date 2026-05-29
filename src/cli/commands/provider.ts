import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { loadSearchCorpus } from "../../retrieval/corpus.js";
import {
  classifyQuery,
  classifyQueryHeuristic,
  type IntentClassification,
} from "../../retrieval/query-intent.js";
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

export interface TestClassifierOptions extends ListLLMsOptions {
  query: string;
  memoryRoot?: string;
  llmFactory?: (config: LLMConfig | null, env: NodeJS.ProcessEnv) => LLMProvider;
  nowMs?: () => number;
}

export interface TestClassifierResult extends IntentClassification {
  exitCode: number;
  query: string;
  costUsd: number;
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

export interface AuditRotateOptions {
  memoryRoot?: string;
  mode: "plan" | "apply";
  keepDays?: number;
  now?: Date;
}

export interface AuditRotateCandidate {
  path: string;
  archivePath: string;
  family: string;
  date: string;
}

export interface AuditRotateResult {
  exitCode: number;
  applied: boolean;
  keepDays: number;
  candidates: AuditRotateCandidate[];
  archived: AuditRotateCandidate[];
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

export async function runTestClassifier(
  opts: TestClassifierOptions,
): Promise<TestClassifierResult> {
  const env = opts.env ?? process.env;
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const nowMs = opts.nowMs ?? (() => Date.now());

  try {
    const heuristic = classifyQueryHeuristic(opts.query);
    if (env["MEMORY_LLM_DISABLED"]?.trim().toLowerCase() === "true" || heuristic) {
      const classification = await classifyQuery({
        query: opts.query,
        vaultRoot: root,
        env,
        nowMs,
      });
      return {
        ...classification,
        exitCode: 0,
        query: opts.query,
        costUsd: 0,
      };
    }

    const config = await (opts.configLoader ?? (() => loadMemoryConfig(root)))();
    const llm = (opts.llmFactory ?? createLLMFromConfig)(getActiveLLMConfig(config), env);
    const classification = await classifyQuery({
      query: opts.query,
      llm,
      vaultRoot: root,
      env,
      nowMs,
    });
    return {
      ...classification,
      exitCode: 0,
      query: opts.query,
      costUsd: classification.method === "llm" ? 0.0001 : 0,
    };
  } catch (error) {
    return {
      exitCode: 1,
      query: opts.query,
      label: "open-ended",
      confidence: 0.5,
      method: "fallback",
      latencyMs: 0,
      costUsd: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatTestClassifierResult(result: TestClassifierResult): string {
  const lines = [
    `Query: ${result.query}`,
    `Label: ${result.label}`,
    `Confidence: ${result.confidence.toFixed(2)}`,
    `Method: ${result.method}`,
    `Latency: ${result.latencyMs}ms`,
  ];
  if (result.method === "llm") {
    lines.push(`Tokens: ${result.tokensIn ?? "unknown"}/${result.tokensOut ?? "unknown"}`);
  }
  lines.push(`Cost: ${result.costUsd === 0 ? "$0.00" : `$${result.costUsd.toFixed(4)}`}`);
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
    `Total cost: ${formatCost(result.totalCostUsd, result.unknownCostCalls)}`,
  ];
  if (result.byConsumer.length > 0) {
    lines.push(
      "",
      "By consumer:",
      ...result.byConsumer.map((item) =>
        [
          `  ${item.consumer}: ${item.calls} call${item.calls === 1 ? "" : "s"}, ${formatCost(item.costUsd, item.unknownCostCalls)}`,
          `    References stripped: ${item.referencesStripped} (avg ${averageReferencesStripped(item.referencesStripped, item.calls)} per call)`,
          `    Prose path leaks: ${item.prosePathLeaks} (avg ${averageReferencesStripped(item.prosePathLeaks, item.calls)} per call)`,
        ].join("\n")
      ),
    );
  }
  if (result.byProviderModel.length > 0) {
    lines.push(
      "",
      "By provider/model:",
      ...result.byProviderModel.map((item) =>
        `  ${item.provider}/${item.model}: ${item.calls} call${item.calls === 1 ? "" : "s"}, tokens ${item.tokensIn}/${item.tokensOut}, ${formatCost(item.costUsd, item.unknownCostCalls)}`
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runAuditRotate(
  opts: AuditRotateOptions,
): Promise<AuditRotateResult> {
  const keepDays = opts.keepDays ?? 30;
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const auditDir = join(root, "wiki", ".audit");
  const archiveDir = join(auditDir, "archive");
  const candidates = await findAuditRotateCandidates(auditDir, keepDays, opts.now ?? new Date());
  const result: AuditRotateResult = {
    exitCode: 0,
    applied: opts.mode === "apply",
    keepDays,
    candidates,
    archived: [],
  };

  if (opts.mode === "plan" || candidates.length === 0) return result;

  await mkdir(archiveDir, { recursive: true });
  for (const candidate of candidates) {
    const sourcePath = join(root, ...candidate.path.split("/"));
    const archivePath = await uniqueArchivePath(join(root, ...candidate.archivePath.split("/")));
    await rename(sourcePath, archivePath);
    result.archived.push({
      ...candidate,
      archivePath: `wiki/.audit/archive/${basename(archivePath)}`,
    });
  }
  return result;
}

export function formatAuditRotateResult(result: AuditRotateResult): string {
  const lines = [
    `Mode: ${result.applied ? "apply" : "plan"}`,
    `Keep days: ${result.keepDays}`,
    `Candidates: ${result.candidates.length}`,
  ];
  const rows = result.applied ? result.archived : result.candidates;
  if (rows.length > 0) {
    lines.push(
      "",
      ...(rows.map((candidate) => `  ${candidate.path} -> ${candidate.archivePath}`)),
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

function averageReferencesStripped(referencesStripped: number, calls: number): string {
  return calls > 0 ? (referencesStripped / calls).toFixed(1) : "0.0";
}

function formatCost(costUsd: number, unknownCostCalls: number): string {
  const base = `$${costUsd.toFixed(4)}`;
  return unknownCostCalls > 0
    ? `${base} (${unknownCostCalls} unknown)`
    : base;
}

function stateBracket(value: string): string {
  return `[${value}]`;
}

async function findAuditRotateCandidates(
  auditDir: string,
  keepDays: number,
  now: Date,
): Promise<AuditRotateCandidate[]> {
  if (!(await pathExists(auditDir))) return [];
  const minTime = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ) - Math.max(0, keepDays - 1) * 24 * 60 * 60 * 1000;
  const candidates: AuditRotateCandidate[] = [];

  for (const entry of await readdir(auditDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parsed = parseAuditLogName(entry.name);
    if (!parsed) continue;
    const fileTime = Date.parse(`${parsed.date}T00:00:00.000Z`);
    if (!Number.isFinite(fileTime) || fileTime >= minTime) continue;
    candidates.push({
      path: `wiki/.audit/${entry.name}`,
      archivePath: `wiki/.audit/archive/${entry.name}`,
      family: parsed.family,
      date: parsed.date,
    });
  }

  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

function parseAuditLogName(name: string): { family: string; date: string } | null {
  const llm = /^llm-(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
  if (llm) return { family: "llm", date: llm[1]! };
  const runLog = /^(thread-propose|procedure-propose|consolidate|compile)-(\d{4}-\d{2}-\d{2})(?:.*)?\.md$/.exec(name);
  if (runLog) return { family: runLog[1]!, date: runLog[2]! };
  return null;
}

async function uniqueArchivePath(path: string): Promise<string> {
  if (!(await pathExists(path))) return path;
  const extension = extname(path);
  const stem = path.slice(0, extension.length > 0 ? -extension.length : undefined);
  for (let index = 1; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!(await pathExists(candidate))) return candidate;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
