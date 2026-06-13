import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";
import { withFileLock } from "../storage/file-lock.js";

export interface CompileConsumedWatermark {
  bytes: number;
  lastObservationAt?: string;
  compressVersion?: number;
}

export interface CompileStateFile {
  status?: string;
  lastRun?: unknown;
  consumed?: Record<string, CompileConsumedWatermark>;
  compressed?: Record<string, CompileConsumedWatermark>;
  [key: string]: unknown;
}

export interface CompilePendingSummary {
  filesWithPendingTail: number;
  pendingTailBytes: number;
  totalRawFiles: number;
  filesFullyDrained: number;
  filesUnseen: number;
}

export interface CompilePendingSummaryCache {
  entries: Map<string, CompilePendingSummaryCacheEntry>;
  ttlMs: number;
  stats: {
    summaryCacheHits: number;
    summaryRefreshes: number;
  };
}

interface CompilePendingSummaryCacheEntry {
  cacheKey: string;
  createdAtMs: number;
  summary: CompilePendingSummary;
}

interface RawFileSize {
  relPath: string;
  size: number;
}

const DEFAULT_PENDING_SUMMARY_CACHE_TTL_MS = 1_000;

export function compileRuntimeDir(vaultRoot: string): string {
  return join(vaultRoot, "var", "compile");
}

export function compileStatePath(vaultRoot: string): string {
  return join(compileRuntimeDir(vaultRoot), "state.json");
}

export function legacyCompileStatePath(vaultRoot: string): string {
  return join(vaultRoot, "state", "compile-state.json");
}

export function scheduledCompilePromptRelPath(): string {
  return "var/compile/scheduled-compile-prompt.md";
}

export function scheduledCompilePromptPath(vaultRoot: string): string {
  return join(vaultRoot, ...scheduledCompilePromptRelPath().split("/"));
}

export async function readCompileStateFile(vaultRoot: string): Promise<CompileStateFile> {
  const path = compileStatePath(vaultRoot);
  if (existsSync(path)) return readCompileStateJson(path);

  const legacyPath = legacyCompileStatePath(vaultRoot);
  if (!existsSync(legacyPath)) return {};
  const state = await readCompileStateJson(legacyPath);
  await writeCompileStateFile(vaultRoot, state);
  return state;
}

async function readCompileStateJson(path: string): Promise<CompileStateFile> {
  const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as CompileStateFile
    : {};
}

export async function writeCompileStateFile(vaultRoot: string, state: CompileStateFile): Promise<void> {
  await atomicWrite(compileStatePath(vaultRoot), `${JSON.stringify(state, null, 2)}\n`);
}

export async function mutateCompileStateFile(
  vaultRoot: string,
  mutator: (state: CompileStateFile) => CompileStateFile | Promise<CompileStateFile>,
): Promise<CompileStateFile> {
  return withFileLock(compileStatePath(vaultRoot), async () => {
    let state: CompileStateFile;
    try {
      state = await readCompileStateFile(vaultRoot);
    } catch {
      state = {};
    }
    const next = await mutator(state);
    await writeCompileStateFile(vaultRoot, next);
    return next;
  });
}

export function readConsumedMap(state: CompileStateFile): Record<string, CompileConsumedWatermark> {
  return readWatermarkMap(state.consumed);
}

export function readCompressedMap(state: CompileStateFile): Record<string, CompileConsumedWatermark> {
  return readWatermarkMap(state.compressed);
}

export function createCompilePendingSummaryCache(ttlMs = DEFAULT_PENDING_SUMMARY_CACHE_TTL_MS): CompilePendingSummaryCache {
  return {
    entries: new Map(),
    ttlMs,
    stats: {
      summaryCacheHits: 0,
      summaryRefreshes: 0,
    },
  };
}

export function invalidateCompilePendingSummaryCache(cache: CompilePendingSummaryCache, vaultRoot?: string): void {
  if (vaultRoot) {
    cache.entries.delete(vaultRoot);
  } else {
    cache.entries.clear();
  }
}

export function emptyCompilePendingSummary(): CompilePendingSummary {
  return {
    filesWithPendingTail: 0,
    pendingTailBytes: 0,
    totalRawFiles: 0,
    filesFullyDrained: 0,
    filesUnseen: 0,
  };
}

export async function readCompilePendingSummary(
  vaultRoot: string,
  opts: { cache?: CompilePendingSummaryCache; now?: () => number } = {},
): Promise<CompilePendingSummary> {
  const cacheKey = await compilePendingSummaryCacheKey(vaultRoot);
  const now = opts.now?.() ?? Date.now();
  const cached = opts.cache?.entries.get(vaultRoot);
  if (cached && cached.cacheKey === cacheKey && now - cached.createdAtMs <= opts.cache!.ttlMs) {
    opts.cache!.stats.summaryCacheHits += 1;
    return cached.summary;
  }

  const summary = await summarizeCompilePending(vaultRoot, await readCompileStateFile(vaultRoot));
  if (opts.cache) {
    opts.cache.stats.summaryRefreshes += 1;
    opts.cache.entries.set(vaultRoot, {
      cacheKey,
      createdAtMs: now,
      summary,
    });
  }
  return summary;
}

export async function summarizeCompilePending(
  vaultRoot: string,
  state: CompileStateFile,
): Promise<CompilePendingSummary> {
  return summarizeCompilePendingFiles(await listRawMarkdownFileSizes(vaultRoot), readConsumedMap(state));
}

export function summarizeCompilePendingFiles(
  rawFiles: RawFileSize[],
  consumed: Record<string, CompileConsumedWatermark>,
): CompilePendingSummary {
  const summary = emptyCompilePendingSummary();
  summary.totalRawFiles = rawFiles.length;

  for (const file of rawFiles) {
    const watermark = consumed[file.relPath];
    if (!watermark) {
      summary.filesUnseen += 1;
      continue;
    }
    if (file.size === watermark.bytes) {
      summary.filesFullyDrained += 1;
      continue;
    }
    summary.filesWithPendingTail += 1;
    summary.pendingTailBytes += file.size > watermark.bytes ? file.size - watermark.bytes : file.size;
  }

  return summary;
}

function readWatermarkMap(value: unknown): Record<string, CompileConsumedWatermark> {
  const consumed = value;
  if (!consumed || typeof consumed !== "object" || Array.isArray(consumed)) return {};
  const normalized: Record<string, CompileConsumedWatermark> = {};
  for (const [path, value] of Object.entries(consumed) as Array<[string, unknown]>) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const bytes = record["bytes"];
    const lastObservationAt = record["lastObservationAt"];
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) continue;
    normalized[path] = {
      bytes: Math.floor(bytes),
      ...(typeof lastObservationAt === "string" ? { lastObservationAt } : {}),
      ...(typeof record["compressVersion"] === "number" && Number.isInteger(record["compressVersion"]) && record["compressVersion"] > 0
        ? { compressVersion: record["compressVersion"] }
        : {}),
    };
  }
  return normalized;
}

async function compilePendingSummaryCacheKey(vaultRoot: string): Promise<string> {
  const rawRoot = join(vaultRoot, "raw");
  const rawRootSignature = await pathSignature(rawRoot);
  const stateSignature = await pathSignature(compileStatePath(vaultRoot));
  return `${rawRootSignature}|${stateSignature}`;
}

async function pathSignature(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "missing";
  }
}

async function listRawMarkdownFileSizes(vaultRoot: string): Promise<RawFileSize[]> {
  const rawRoot = join(vaultRoot, "raw");
  if (!existsSync(rawRoot)) return [];
  const files: RawFileSize[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const info = await stat(fullPath);
        files.push({
          relPath: relative(vaultRoot, fullPath).replace(/\\/g, "/"),
          size: info.size,
        });
      }
    }
  }

  await walk(rawRoot);
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
