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
  captureDebounceSeconds: number;
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

export interface AutoHealTickOptions extends AutoHealOptions {
  reconcile?: boolean;
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

interface QueuedCapture {
  path: string;
  dueAt: string;
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
const DEFAULT_CAPTURE_DEBOUNCE_SECONDS = 30;

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

  if (settings.captureDebounceSeconds > 0) {
    await queueAutoHealCapture(opts, relPath, settings.captureDebounceSeconds);
    return resultFromRefresh(settings, status, {
      embedded: 0,
      unchanged: 0,
      pruned: 0,
      errors: [],
      totalRecords: 0,
      skippedPending: 1,
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
  opts: AutoHealTickOptions,
): Promise<AutoHealRunResult> {
  const config = await loadConfig(opts);
  const settings = readAutoHealSettings(config);
  const now = opts.now?.() ?? new Date();
  const status = await loadPersistedStatus(opts.memoryRoot, now);
  status.lastTick = now.toISOString();
  await savePersistedStatus(opts.memoryRoot, status);
  if (!settings.enabled) return disabledResult(settings, status);

  const queuedCaptures = await runDueQueuedCaptures({
    ...opts,
    config,
    settings,
    status,
    nowDate: now,
  });
  if (queuedCaptures) return queuedCaptures;

  if (opts.reconcile === false) {
    return resultFromRefresh(settings, status, {
      embedded: 0,
      unchanged: 0,
      pruned: 0,
      errors: [],
      totalRecords: 0,
    }, 0);
  }

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
    captureDebounceSeconds: readNonNegativeInteger(
      raw.capture_debounce_seconds,
      DEFAULT_CAPTURE_DEBOUNCE_SECONDS,
    ),
  };
}

async function runDueQueuedCaptures(opts: AutoHealOptions & {
  config: MemoryConfig;
  settings: AutoHealSettings;
  status: PersistedAutoHealStatus;
  nowDate: Date;
}): Promise<AutoHealRunResult | null> {
  const queued = await readDueQueuedCaptures(opts.memoryRoot, opts.nowDate);
  if (queued.length === 0) return null;

  const selected = queued.slice(0, opts.settings.maxDocsPerTick);
  const corpus = await loadSearchCorpus({ vaultRoot: opts.memoryRoot, scope: "raw" });
  const documentsByPath = new Map(corpus.documents.map((document) => [document.relPath, document] as const));
  const documents: SearchDocument[] = [];
  const missing: Array<{ path: string; reason: string }> = [];
  for (const capture of selected) {
    const document = documentsByPath.get(capture.path);
    if (document) {
      documents.push(document);
      continue;
    }
    const reason = "document not found in raw corpus";
    missing.push({ path: capture.path, reason });
    await writeAutoHealLog(opts, {
      ts: nowIso(opts),
      source: "capture-time",
      path: capture.path,
      tokens: 0,
      cost_usd: 0,
      outcome: "skipped",
      reason,
    });
  }

  let result = documents.length > 0
    ? await runRefresh({
      ...opts,
      source: "capture-time",
      documents,
      maxPending: documents.length,
      preserveUnknownRecords: true,
    })
    : resultFromRefresh(opts.settings, opts.status, {
      embedded: 0,
      unchanged: 0,
      pruned: 0,
      errors: [],
      totalRecords: 0,
    }, 0);

  if (missing.length > 0) {
    result = {
      ...result,
      exitCode: result.exitCode === 0 ? 1 : result.exitCode,
      errors: [...missing, ...result.errors],
    };
  }
  await markQueuedCapturesProcessed(opts.memoryRoot, selected);
  return result;
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
      opts.status.lastEmbed = nowIso(opts);
      await writeAutoHealLog(opts, {
        ts: opts.status.lastEmbed,
        source: opts.source,
        path: batchPath(batch),
        tokens,
        cost_usd: cost,
        outcome: "embedded",
      });
      if (opts.logWriter) {
        opts.status.dailySpendUsd += cost;
      } else {
        opts.status.dailySpendUsd = await readAutoHealDailySpendUsd(opts.memoryRoot, opts.status.day);
      }
      await savePersistedStatus(opts.memoryRoot, opts.status);
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
  const dailySpendUsd = await readAutoHealDailySpendUsd(memoryRoot, today);
  try {
    const parsed = JSON.parse(await readFile(statusPath(memoryRoot), "utf-8")) as Partial<PersistedAutoHealStatus>;
    if (parsed.day === today) {
      return {
        day: today,
        dailySpendUsd,
        lastTick: typeof parsed.lastTick === "string" ? parsed.lastTick : null,
        lastEmbed: typeof parsed.lastEmbed === "string" ? parsed.lastEmbed : null,
      };
    }
    return {
      day: today,
      dailySpendUsd,
      lastTick: typeof parsed.lastTick === "string" ? parsed.lastTick : null,
      lastEmbed: typeof parsed.lastEmbed === "string" ? parsed.lastEmbed : null,
    };
  } catch {
    return { day: today, dailySpendUsd, lastTick: null, lastEmbed: null };
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

function autoHealCaptureQueuePath(memoryRoot: string): string {
  return join(memoryRoot, "embeddings", "auto-heal-capture-queue.jsonl");
}

function autoHealCaptureStatePath(memoryRoot: string): string {
  return join(memoryRoot, "embeddings", "auto-heal-capture-state.json");
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function queueAutoHealCapture(
  opts: Pick<AutoHealOptions, "memoryRoot" | "now">,
  relPath: string,
  debounceSeconds: number,
): Promise<void> {
  const now = opts.now?.() ?? new Date();
  const dueAt = new Date(now.getTime() + debounceSeconds * 1000).toISOString();
  await mkdir(join(opts.memoryRoot, "embeddings"), { recursive: true });
  await atomicAppend(
    autoHealCaptureQueuePath(opts.memoryRoot),
    `${JSON.stringify({ ts: now.toISOString(), path: relPath, dueAt })}\n`,
  );
}

async function readDueQueuedCaptures(
  memoryRoot: string,
  now: Date,
): Promise<QueuedCapture[]> {
  const latestByPath = new Map<string, string>();
  try {
    const content = await readFile(autoHealCaptureQueuePath(memoryRoot), "utf-8");
    for (const line of content.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const parsed = JSON.parse(line) as Partial<QueuedCapture>;
      if (typeof parsed.path !== "string" || typeof parsed.dueAt !== "string") continue;
      if (!Number.isFinite(Date.parse(parsed.dueAt))) continue;
      const existing = latestByPath.get(parsed.path);
      if (!existing || Date.parse(parsed.dueAt) >= Date.parse(existing)) {
        latestByPath.set(normalizeRelPath(parsed.path), parsed.dueAt);
      }
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  if (latestByPath.size === 0) return [];
  const processed = await readCaptureQueueState(memoryRoot);
  const nowMs = now.getTime();
  return [...latestByPath.entries()]
    .filter(([path, dueAt]) => {
      const dueAtMs = Date.parse(dueAt);
      const processedAt = processed[path];
      return dueAtMs <= nowMs &&
        (!processedAt || Date.parse(processedAt) < dueAtMs);
    })
    .map(([path, dueAt]) => ({ path, dueAt }))
    .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt));
}

async function markQueuedCapturesProcessed(
  memoryRoot: string,
  captures: QueuedCapture[],
): Promise<void> {
  if (captures.length === 0) return;
  const processed = await readCaptureQueueState(memoryRoot);
  for (const capture of captures) {
    processed[capture.path] = capture.dueAt;
  }
  await atomicWrite(
    autoHealCaptureStatePath(memoryRoot),
    `${JSON.stringify({ processed }, null, 2)}\n`,
  );
}

async function readCaptureQueueState(memoryRoot: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(autoHealCaptureStatePath(memoryRoot), "utf-8")) as {
      processed?: Record<string, unknown>;
    };
    const processed: Record<string, string> = {};
    for (const [path, dueAt] of Object.entries(parsed.processed ?? {})) {
      if (typeof dueAt === "string") {
        processed[normalizeRelPath(path)] = dueAt;
      }
    }
    return processed;
  } catch (error) {
    if (isMissingFile(error)) return {};
    return {};
  }
}

async function readAutoHealDailySpendUsd(
  memoryRoot: string,
  day: string,
): Promise<number> {
  let content: string;
  try {
    content = await readFile(autoHealLogPath(memoryRoot), "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const end = start + 24 * 60 * 60 * 1000;
  let spend = 0;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Partial<AutoHealLogEntry>;
      const ts = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : Number.NaN;
      if (
        parsed.outcome === "embedded" &&
        ts >= start &&
        ts < end &&
        typeof parsed.cost_usd === "number" &&
        Number.isFinite(parsed.cost_usd)
      ) {
        spend += parsed.cost_usd;
      }
    } catch {
      // Ignore malformed log lines; status is a best-effort read of the append log.
    }
  }
  return spend;
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

function readNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT";
}
