import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicAppend, atomicWrite } from "../storage/atomic-write.js";
import { loadMemoryConfig, type MemoryConfig } from "../storage/config.js";
import { loadSearchCorpus, type SearchDocument } from "./corpus.js";
import {
  createEmbedderFromConfig,
  estimateEmbeddingCostUsd,
  getActiveEmbedderConfig,
  getEmbedderExpectedDim,
  type EmbedderConfig,
} from "./embedder/factory.js";
import type { Embedder } from "./embedder/types.js";
import {
  refreshEmbeddings,
  type RefreshEmbeddingBatch,
  type RefreshResult,
} from "./refresh.js";

export type AutoHealSource = "capture-time" | "reconciler";

export interface AutoHealSettings {
  enabled: boolean;
  dailyBudgetUsd: number;
  maxDocsPerTick: number;
  maxTokensPerTick: number;
  tickIntervalSeconds: number;
}

export interface AutoHealStatus {
  enabled: boolean;
  lastTick: string | null;
  lastEmbed: string | null;
  dailySpendUsd: number;
  dailyBudgetUsd: number;
  nextReset: string;
}

export interface AutoHealLogEntry {
  ts: string;
  source: AutoHealSource;
  path: string;
  tokens: number;
  cost_usd: number;
  outcome: "embedded" | "skipped" | "failed";
  reason?: string;
}

export interface AutoHealRunResult {
  exitCode: number;
  enabled: boolean;
  embedded: number;
  unchanged: number;
  skippedPending: number;
  skippedBudget: number;
  errors: Array<{ path: string; reason: string }>;
  dailySpendUsd: number;
  dailyBudgetUsd: number;
  nextReset: string;
  lastTick?: string | null;
  lastEmbed?: string | null;
}

export interface AutoHealOptions {
  memoryRoot: string;
  configLoader?: () => Promise<MemoryConfig>;
  env?: NodeJS.ProcessEnv;
  embedderFactory?: (config: EmbedderConfig, env: NodeJS.ProcessEnv) => Embedder;
  logWriter?: (entry: AutoHealLogEntry) => Promise<void>;
  now?: () => Date;
}

export interface AutoHealCaptureOptions extends AutoHealOptions {
  relPath: string;
}

interface PersistedAutoHealStatus {
  day: string;
  dailySpendUsd: number;
  lastTick: string | null;
  lastEmbed: string | null;
}

class AutoHealSkippedError extends Error {
  constructor(
    message: string,
    public readonly reason: "daily budget reached" | "tick token cap reached",
  ) {
    super(message);
    this.name = "AutoHealSkippedError";
  }
}

const DEFAULT_DAILY_BUDGET_USD = 0.5;
const DEFAULT_MAX_DOCS_PER_TICK = 25;
const DEFAULT_MAX_TOKENS_PER_TICK = 50_000;
const DEFAULT_TICK_INTERVAL_SECONDS = 300;

export async function runAutoHealCapture(
  opts: AutoHealCaptureOptions,
): Promise<AutoHealRunResult> {
  const config = await loadConfig(opts);
  const settings = readAutoHealSettings(config);
  const status = await loadPersistedStatus(opts.memoryRoot, opts.now?.() ?? new Date());
  if (!settings.enabled) return disabledResult(settings, status);

  const relPath = normalizeRelPath(opts.relPath);
  const corpus = await loadSearchCorpus({ vaultRoot: opts.memoryRoot, scope: "raw" });
  const document = corpus.documents.find((item) => item.relPath === relPath);
  if (!document) {
    const reason = "document not found in raw corpus";
    await writeAutoHealLog(opts, {
      ts: nowIso(opts),
      source: "capture-time",
      path: relPath,
      tokens: 0,
      cost_usd: 0,
      outcome: "skipped",
      reason,
    });
    return resultFromRefresh(settings, status, {
      embedded: 0,
      unchanged: 0,
      pruned: 0,
      errors: [{ path: relPath, reason }],
      totalRecords: 0,
    }, 0);
  }

  return runRefresh({
    ...opts,
    source: "capture-time",
    config,
    settings,
    status,
    documents: [document],
    maxPending: 1,
    preserveUnknownRecords: true,
  });
}

export async function runAutoHealTick(
  opts: AutoHealOptions,
): Promise<AutoHealRunResult> {
  const config = await loadConfig(opts);
  const settings = readAutoHealSettings(config);
  const now = opts.now?.() ?? new Date();
  const status = await loadPersistedStatus(opts.memoryRoot, now);
  status.lastTick = now.toISOString();
  await savePersistedStatus(opts.memoryRoot, status);
  if (!settings.enabled) return disabledResult(settings, status);

  const corpus = await loadSearchCorpus({ vaultRoot: opts.memoryRoot, scope: "all" });
  if (corpus.errors.length > 0) {
    return resultFromRefresh(settings, status, {
      embedded: 0,
      unchanged: 0,
      pruned: 0,
      errors: corpus.errors,
      totalRecords: 0,
    }, 0);
  }

  return runRefresh({
    ...opts,
    source: "reconciler",
    config,
    settings,
    status,
    documents: corpus.documents,
    maxPending: settings.maxDocsPerTick,
    preserveUnknownRecords: false,
  });
}

export async function readAutoHealStatus(
  memoryRoot: string,
  opts: {
    configLoader?: () => Promise<MemoryConfig>;
    now?: () => Date;
  } = {},
): Promise<AutoHealStatus> {
  const config = await (opts.configLoader ?? (() => loadMemoryConfig(memoryRoot)))();
  const settings = readAutoHealSettings(config);
  const status = await loadPersistedStatus(memoryRoot, opts.now?.() ?? new Date());
  return {
    enabled: settings.enabled,
    lastTick: status.lastTick,
    lastEmbed: status.lastEmbed,
    dailySpendUsd: status.dailySpendUsd,
    dailyBudgetUsd: settings.dailyBudgetUsd,
    nextReset: nextUtcReset(status.day),
  };
}

export function readAutoHealSettings(config: MemoryConfig): AutoHealSettings {
  const raw = typeof config.auto_heal === "object" && config.auto_heal !== null
    ? config.auto_heal
    : {};
  return {
    enabled: raw.enabled === true,
    dailyBudgetUsd: readNonNegativeNumber(raw.daily_budget_usd, DEFAULT_DAILY_BUDGET_USD),
    maxDocsPerTick: readPositiveInteger(raw.max_docs_per_tick, DEFAULT_MAX_DOCS_PER_TICK),
    maxTokensPerTick: readPositiveInteger(raw.max_tokens_per_tick, DEFAULT_MAX_TOKENS_PER_TICK),
    tickIntervalSeconds: readPositiveInteger(raw.tick_interval_seconds, DEFAULT_TICK_INTERVAL_SECONDS),
  };
}

async function runRefresh(opts: AutoHealOptions & {
  source: AutoHealSource;
  config: MemoryConfig;
  settings: AutoHealSettings;
  status: PersistedAutoHealStatus;
  documents: SearchDocument[];
  maxPending: number;
  preserveUnknownRecords: boolean;
}): Promise<AutoHealRunResult> {
  let active: EmbedderConfig;
  let embedder: Embedder;
  try {
    active = getActiveEmbedderConfig(opts.config);
    embedder = (opts.embedderFactory ?? createEmbedderFromConfig)(active, opts.env ?? process.env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const paths = opts.documents.length > 0 ? opts.documents.map((item) => item.relPath) : ["(corpus)"];
    for (const path of paths.slice(0, Math.max(1, opts.maxPending))) {
      await writeAutoHealLog(opts, {
        ts: nowIso(opts),
        source: opts.source,
        path,
        tokens: 0,
        cost_usd: 0,
        outcome: "skipped",
        reason,
      });
    }
    return resultFromRefresh(opts.settings, opts.status, {
      embedded: 0,
      unchanged: 0,
      pruned: 0,
      errors: paths.slice(0, 1).map((path) => ({ path, reason })),
      totalRecords: 0,
    }, 0);
  }

  let skippedBudget = 0;
  let tickTokens = 0;
  const expectedDim = getEmbedderExpectedDim(active);
  const refresh = await refreshEmbeddings({
    memoryRoot: opts.memoryRoot,
    documents: opts.documents,
    embedClient: embedder,
    expectedDim,
    maxPending: opts.maxPending,
    batchSize: 1,
    preserveUnknownRecords: opts.preserveUnknownRecords,
    onEmbedBatchStart: async (batch) => {
      const estimatedTokens = batch.tokenEstimate;
      const estimatedCost = estimateEmbeddingCostUsd(active.provider, estimatedTokens);
      const path = batchPath(batch);
      if (tickTokens + estimatedTokens > opts.settings.maxTokensPerTick) {
        skippedBudget += batch.documents.length;
        await writeAutoHealLog(opts, {
          ts: nowIso(opts),
          source: opts.source,
          path,
          tokens: estimatedTokens,
          cost_usd: 0,
          outcome: "skipped",
          reason: "tick token cap reached",
        });
        throw new AutoHealSkippedError("tick token cap reached", "tick token cap reached");
      }
      if (opts.status.dailySpendUsd + estimatedCost > opts.settings.dailyBudgetUsd) {
        skippedBudget += batch.documents.length;
        await writeAutoHealLog(opts, {
          ts: nowIso(opts),
          source: opts.source,
          path,
          tokens: estimatedTokens,
          cost_usd: 0,
          outcome: "skipped",
          reason: "daily budget reached",
        });
        throw new AutoHealSkippedError("daily budget reached", "daily budget reached");
      }
      tickTokens += estimatedTokens;
    },
    onEmbedBatchSuccess: async (batch, response) => {
      const tokens = response.inputTokens ?? batch.tokenEstimate;
      const cost = estimateEmbeddingCostUsd(active.provider, tokens);
      opts.status.dailySpendUsd += cost;
      opts.status.lastEmbed = nowIso(opts);
      await savePersistedStatus(opts.memoryRoot, opts.status);
      await writeAutoHealLog(opts, {
        ts: opts.status.lastEmbed,
        source: opts.source,
        path: batchPath(batch),
        tokens,
        cost_usd: cost,
        outcome: "embedded",
      });
    },
    onEmbedBatchError: async (batch, error) => {
      if (error instanceof AutoHealSkippedError) return;
      await writeAutoHealLog(opts, {
        ts: nowIso(opts),
        source: opts.source,
        path: batchPath(batch),
        tokens: batch.tokenEstimate,
        cost_usd: 0,
        outcome: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    },
  });

  return resultFromRefresh(opts.settings, opts.status, refresh, skippedBudget);
}

function resultFromRefresh(
  settings: AutoHealSettings,
  status: PersistedAutoHealStatus,
  refresh: RefreshResult,
  skippedBudget: number,
): AutoHealRunResult {
  return {
    exitCode: refresh.errors.length > 0 && skippedBudget === 0 ? 1 : 0,
    enabled: settings.enabled,
    embedded: refresh.embedded,
    unchanged: refresh.unchanged,
    skippedPending: refresh.skippedPending ?? 0,
    skippedBudget,
    errors: refresh.errors,
    dailySpendUsd: status.dailySpendUsd,
    dailyBudgetUsd: settings.dailyBudgetUsd,
    nextReset: nextUtcReset(status.day),
    lastTick: status.lastTick,
    lastEmbed: status.lastEmbed,
  };
}

function disabledResult(
  settings: AutoHealSettings,
  status: PersistedAutoHealStatus,
): AutoHealRunResult {
  return {
    exitCode: 0,
    enabled: false,
    embedded: 0,
    unchanged: 0,
    skippedPending: 0,
    skippedBudget: 0,
    errors: [],
    dailySpendUsd: status.dailySpendUsd,
    dailyBudgetUsd: settings.dailyBudgetUsd,
    nextReset: nextUtcReset(status.day),
    lastTick: status.lastTick,
    lastEmbed: status.lastEmbed,
  };
}

async function loadConfig(opts: AutoHealOptions): Promise<MemoryConfig> {
  return (opts.configLoader ?? (() => loadMemoryConfig(opts.memoryRoot)))();
}

async function loadPersistedStatus(
  memoryRoot: string,
  now: Date,
): Promise<PersistedAutoHealStatus> {
  const today = dayKey(now);
  try {
    const parsed = JSON.parse(await readFile(statusPath(memoryRoot), "utf-8")) as Partial<PersistedAutoHealStatus>;
    if (parsed.day === today) {
      return {
        day: today,
        dailySpendUsd: typeof parsed.dailySpendUsd === "number" && Number.isFinite(parsed.dailySpendUsd)
          ? parsed.dailySpendUsd
          : 0,
        lastTick: typeof parsed.lastTick === "string" ? parsed.lastTick : null,
        lastEmbed: typeof parsed.lastEmbed === "string" ? parsed.lastEmbed : null,
      };
    }
    return {
      day: today,
      dailySpendUsd: 0,
      lastTick: typeof parsed.lastTick === "string" ? parsed.lastTick : null,
      lastEmbed: typeof parsed.lastEmbed === "string" ? parsed.lastEmbed : null,
    };
  } catch {
    return { day: today, dailySpendUsd: 0, lastTick: null, lastEmbed: null };
  }
}

async function savePersistedStatus(
  memoryRoot: string,
  status: PersistedAutoHealStatus,
): Promise<void> {
  await atomicWrite(statusPath(memoryRoot), `${JSON.stringify(status, null, 2)}\n`);
}

async function writeAutoHealLog(
  opts: Pick<AutoHealOptions, "memoryRoot" | "logWriter">,
  entry: AutoHealLogEntry,
): Promise<void> {
  if (opts.logWriter) {
    await opts.logWriter(entry);
    return;
  }
  await mkdir(join(opts.memoryRoot, "embeddings"), { recursive: true });
  await atomicAppend(autoHealLogPath(opts.memoryRoot), `${JSON.stringify(entry)}\n`);
}

function batchPath(batch: RefreshEmbeddingBatch): string {
  return batch.documents.map((document) => document.path).join(",");
}

function statusPath(memoryRoot: string): string {
  return join(memoryRoot, "embeddings", "auto-heal-status.json");
}

function autoHealLogPath(memoryRoot: string): string {
  return join(memoryRoot, "embeddings", "auto-heal.jsonl");
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function nextUtcReset(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).getTime() >= 0
    ? new Date(Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString()
    : new Date(Date.now()).toISOString();
}

function nowIso(opts: Pick<AutoHealOptions, "now">): string {
  return (opts.now?.() ?? new Date()).toISOString();
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
