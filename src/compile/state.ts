import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";
import { listRawMarkdownFiles } from "../storage/raw-walker.js";
import { withFileLock } from "../storage/file-lock.js";

export interface CompileConsumedWatermark {
  bytes: number;
  lastObservationAt?: string;
  compressVersion?: number;
  /**
   * Compress-only resumable coverage. Present only while a file is partially
   * compressed (a fixed sample was replaced by contiguous windows): the next
   * chunk index to process, the total chunk count, and the maxBytesPerCall the
   * chunking was computed with (a config fingerprint — a change restarts the
   * file from chunk 0). Absent = fully covered.
   */
  chunkCursor?: number;
  chunkTotal?: number;
  chunkBytes?: number;
  /**
   * Content identity of the consumed source. `bytes` alone cannot detect a
   * same-length in-place edit (which then reads as "already done" and is
   * suppressed from compile — a conservation hole). `mtimeMs` is the cheap
   * change signal (any normal edit bumps it); `sourceHash` (sha256 of the
   * consumed content) disambiguates when mtime changed but content did not
   * (e.g. a git checkout) and binds compaction lineage to a specific source
   * version. Optional for back-compat: absent = legacy size-only behavior.
   */
  mtimeMs?: number;
  sourceHash?: string;
}

export interface CompileLastFilterStats {
  bytesIn: number;
  bytesOut: number;
  rawBytesConsumed: number;
  strippedByClass: Record<string, number>;
  runId: string;
  at: string;
}

export interface CompileStateFile {
  status?: string;
  lastRun?: unknown;
  lastFilterStats?: CompileLastFilterStats;
  consumed?: Record<string, CompileConsumedWatermark>;
  compressed?: Record<string, CompileConsumedWatermark>;
  [key: string]: unknown;
}

export interface ReadCompileStateFileOptions {
  migrateLegacy?: boolean;
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
  mtimeMs?: number;
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

export async function readCompileStateFile(
  vaultRoot: string,
  opts: ReadCompileStateFileOptions = {},
): Promise<CompileStateFile> {
  const path = compileStatePath(vaultRoot);
  if (existsSync(path)) return readCompileStateJson(path);

  const legacyPath = legacyCompileStatePath(vaultRoot);
  if (!existsSync(legacyPath)) return {};
  const state = await readCompileStateJson(legacyPath);
  if (opts.migrateLegacy === false) return state;
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
  const rawFileSizes: RawFileSize[] = (await listRawMarkdownFiles(vaultRoot)).map((f) => ({ relPath: f.relPath, size: f.size, mtimeMs: f.mtimeMs }));
  return summarizeCompilePendingFiles(rawFileSizes, readConsumedMap(state));
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
    // "Fully drained" requires size AND (when recorded) mtime identity — the
    // compile gate is content-aware, so a same-size in-place edit is pending,
    // not drained. This summary stays read-free (dashboard polls it), so a
    // mtime bump with unchanged content conservatively reads as pending here;
    // the compile gate resolves it by hash without paying an LLM call.
    const mtimeMatches = watermark.mtimeMs === undefined
      || file.mtimeMs === undefined
      || watermark.mtimeMs === file.mtimeMs;
    if (file.size === watermark.bytes && mtimeMatches) {
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
      ...(isNonNegativeInt(record["chunkCursor"]) ? { chunkCursor: record["chunkCursor"] } : {}),
      ...(isPositiveInt(record["chunkTotal"]) ? { chunkTotal: record["chunkTotal"] } : {}),
      ...(isPositiveInt(record["chunkBytes"]) ? { chunkBytes: record["chunkBytes"] } : {}),
      ...(typeof record["mtimeMs"] === "number" && Number.isFinite(record["mtimeMs"]) ? { mtimeMs: record["mtimeMs"] } : {}),
      ...(typeof record["sourceHash"] === "string" && record["sourceHash"].length > 0 ? { sourceHash: record["sourceHash"] } : {}),
    };
  }
  return normalized;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
