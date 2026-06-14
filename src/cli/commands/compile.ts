import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { applyCompileOperations, parseCompileOperationsBlock, type ApplyCompileOperationsResult } from "../../compile/execute.js";
import { clearOpsJournal } from "../../compile/ops-journal.js";
import { filterRawText } from "../../compile/filter-raw.js";
import { runFactConsolidation } from "../../compile/fact-consolidate.js";
import { rebuildIndex, type RebuildIndexResult } from "../../compile/index.js";
import { loadCompressedFacts } from "../../facts/store.js";
import { chatWithAudit } from "../../llm/audit.js";
import {
  createLLMFromConfig,
  getActiveLLMConfig,
  type LLMConfig,
} from "../../llm/factory.js";
import { type LLMProvider } from "../../llm/types.js";
import { readRuntimePrompt } from "../../prompts/runtime.js";
import { loadMemoryConfig, resolveCompileConfig, type MemoryConfig } from "../../storage/config.js";
import {
  memoryRoot,
} from "../../storage/paths.js";
import { parseFrontmatter } from "../../storage/frontmatter.js";
import {
  mutateCompileStateFile,
  readCompileStateFile,
  readCompressedMap,
  readConsumedMap,
  summarizeCompilePending,
  writeCompileStateFile,
  type CompilePendingSummary,
  type CompileStateFile,
} from "../../compile/state.js";

export interface CompileOptions {
  vaultRoot?: string;
  since?: string;
  perFileMaxBytes?: number;
  totalMaxBytes?: number;
  existingPagesMaxBytes?: number;
  outputPath?: string;
  execute?: boolean;
  plan?: boolean;
  resetWatermark?: string | boolean;
  env?: NodeJS.ProcessEnv;
  sourceRepoDir?: string;
  configLoader?: () => Promise<MemoryConfig>;
  llmFactory?: (config: LLMConfig | null, env: NodeJS.ProcessEnv) => LLMProvider;
  skipFactConsolidation?: boolean;
  backfill?: boolean;
  maxFilesPerPass?: number;
  excludeRawPaths?: ReadonlySet<string>;
  rawFilter?: boolean;
  rawFilterMinSignalBytes?: number;
  filterReport?: boolean;
}

export interface CompileDrainOptions extends CompileOptions {
  execute: boolean;
  maxPasses?: number;
  onProgress?: (line: string, result: CompileResult | null, pass: number) => void;
}

export interface CompileResult {
  prompt: string;
  rawFilesIncluded: string[];
  rawRelPathsIncluded: string[];
  rawFilesSkipped: { path: string; reason: string }[];
  sinceCutoff: string;
  watermarkMode: "gated" | "bypassed";
  watermarkReset?: { pattern: string | null; cleared: number };
  watermarksAdvanced: string[];
  pendingSummary: CompilePendingSummary;
  truncatedAtTotalCap: boolean;
  rawBytesRemaining: number;
  rawFilesRemaining: number;
  execution?: {
    mode: "plan" | "execute";
    rawInputConsumed?: boolean;
  } & ApplyCompileOperationsResult;
  indexRebuild?: RebuildIndexResult;
  filterStats?: CompileFilterStats;
  filterReport?: CompileFilterReport;
  noiseOnlySkipped: number;
}

export interface CompileFilterStats {
  bytesIn: number;
  bytesOut: number;
  signalBytes: number;
  rawBytesConsumed: number;
  filesFiltered: number;
  strippedByClass: Record<string, number>;
}

export interface CompileFilterReport {
  perFile: CompileFilterReportFile[];
  aggregate: {
    files: number;
    bytesIn: number;
    bytesOut: number;
    reductionPct: number;
    signalBytes: number;
    rawBytesConsumed: number;
    noiseOnlyFiles: number;
    strippedByClass: Record<string, number>;
  };
}

export interface CompileFilterReportFile {
  path: string;
  relPath: string;
  bytesIn: number;
  bytesOut: number;
  reductionPct: number;
  signalBytes: number;
  rawBytesConsumed: number;
  noiseOnly: boolean;
  strippedByClass: Record<string, number>;
}

export interface CompileDrainResult {
  passes: CompileResult[];
  stopReason: "empty" | "max-passes" | "stalled";
  totalRawFilesIncluded: number;
  totalWatermarksAdvanced: number;
  rawBytesRemaining: number;
  rawFilesRemaining: number;
  quarantinedRawPaths?: string[];
}

interface RawCandidate {
  path: string;
  relPath: string;
  mtimeMs: number;
  size: number;
}

interface IncludedRawWatermark {
  relPath: string;
  bytes: number;
  lastObservationAt: string;
}

interface EligibleRaw {
  candidate: RawCandidate;
  content: Buffer;
  startByte: number;
  cursor: number;
  chunks: Buffer[];
  sortGroup: number;
  sortAtMs: number;
}

const DEFAULT_PER_FILE_MAX_BYTES = 10_000;
const DEFAULT_TOTAL_MAX_BYTES = 200_000;
const DEFAULT_EXISTING_PAGES_MAX_BYTES = 40_000;
// Hard cap on files included per pass. Without it, fair round-robin spreads the
// byte budget across every eligible file as tiny slivers, and the per-file
// prompt overhead (path headers + fences + truncation notices) explodes the
// rendered prompt past the LLM context window. Aging + `--drain` rotate through
// the deferred files across passes, so nothing is starved.
export const DEFAULT_MAX_FILES_PER_PASS = 40;
const COMPILE_LOG_RE =
  /^## \[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\] compile \|/gm;

export async function runCompile(
  opts: CompileOptions = {},
): Promise<CompileResult> {
  const perFileMaxBytes = readPositiveInteger(
    opts.perFileMaxBytes,
    DEFAULT_PER_FILE_MAX_BYTES,
    "perFileMaxBytes",
  );
  const totalMaxBytes = readPositiveInteger(
    opts.totalMaxBytes,
    DEFAULT_TOTAL_MAX_BYTES,
    "totalMaxBytes",
  );
  const existingPagesMaxBytes = readPositiveInteger(
    opts.existingPagesMaxBytes,
    DEFAULT_EXISTING_PAGES_MAX_BYTES,
    "existingPagesMaxBytes",
  );
  const root = opts.vaultRoot ?? memoryRoot();
  if (opts.filterReport && opts.resetWatermark !== undefined && opts.resetWatermark !== false) {
    throw new Error("memory compile: --filter-report cannot be combined with --reset-watermark");
  }
  const memoryConfig = await (opts.configLoader ?? (() => loadMemoryConfig(root)))();
  const compileConfig = resolveCompileConfig(memoryConfig.compile);
  const rawFilterEnabled = opts.filterReport ? true : opts.rawFilter ?? compileConfig.raw_filter;
  void (opts.rawFilterMinSignalBytes ?? compileConfig.raw_filter_min_signal_bytes);
  const promptTemplate = await readRuntimePrompt({
    vaultRoot: root,
    name: "compile.md",
    sourceRepoDir: opts.sourceRepoDir,
    warn: (message) => console.error(message),
  }).then((prompt) => prompt.content).catch((error) => {
    throw new Error(`memory compile: ${(error as Error).message}`);
  });
  const schema = await readRequiredFile(join(root, "schema.md"), "schema.md");
  const index = await readOptionalFile(join(root, "index.md"));
  const log = await readOptionalFile(join(root, "log.md"));
  // --backfill: unwatermarked files become eligible regardless of the log-derived
  // cutoff. Watermark gating stays on, so already-drained files are still skipped.
  const sinceDate = opts.since
    ? parseCutoff(opts.since)
    : opts.backfill
      ? new Date(0)
      : detectSinceFromLog(log) ?? new Date(0);
  const watermarkMode: CompileResult["watermarkMode"] = opts.since ? "bypassed" : "gated";
  let compileState = await readCompileStateForCompile(root, { migrateLegacy: !opts.filterReport });
  const watermarkReset = opts.resetWatermark !== undefined && opts.resetWatermark !== false
    ? await resetConsumedWatermarks(root, compileState, opts.resetWatermark)
    : undefined;
  if (watermarkReset) {
    compileState = await readCompileStateForCompile(root);
  }
  const consumed = readConsumedMap(compileState);
  const compressedMap = readCompressedMap(compileState);

  const rawFilesSkipped: CompileResult["rawFilesSkipped"] = [];
  const rawFilesIncluded: string[] = [];
  const includedWatermarks: IncludedRawWatermark[] = [];
  const noiseOnlyWatermarks: IncludedRawWatermark[] = [];
  const rawContentBlocks: string[] = [];
  const eligibleRaws: EligibleRaw[] = [];
  const filterReportFiles: CompileFilterReportFile[] = [];
  const filterStats: CompileFilterStats = {
    bytesIn: 0,
    bytesOut: 0,
    signalBytes: 0,
    rawBytesConsumed: 0,
    filesFiltered: 0,
    strippedByClass: {},
  };
  let totalUsed = 0;
  let truncatedAtTotalCap = false;
  let noiseOnlySkipped = 0;

  const rawFiles = await listRawFiles(root, join(root, "raw"));
  for (const candidate of rawFiles) {
    if (opts.excludeRawPaths?.has(candidate.relPath)) {
      rawFilesSkipped.push({
        path: candidate.path,
        reason: "quarantined this run after a no-progress pass",
      });
      continue;
    }
    const compressedWatermark = compressedMap[candidate.relPath];
    if (compressedWatermark && compressedWatermark.bytes >= candidate.size) {
      rawFilesSkipped.push({
        path: candidate.path,
        reason: "fully covered by compress — facts already extracted",
      });
      continue;
    }
    let startByte = 0;
    const watermark = watermarkMode === "gated" ? consumed[candidate.relPath] : undefined;
    if (watermarkMode === "gated" && watermark) {
      if (candidate.size === watermark.bytes) {
        rawFilesSkipped.push({
          path: candidate.path,
          reason: "already consumed to watermark",
        });
        continue;
      }
      startByte = candidate.size < watermark.bytes ? 0 : watermark.bytes;
    } else if (candidate.mtimeMs < sinceDate.getTime()) {
      rawFilesSkipped.push({
        path: candidate.path,
        reason: "before since cutoff",
      });
      continue;
    }

    let content: Buffer;
    try {
      content = await readFile(candidate.path);
    } catch (err) {
      rawFilesSkipped.push({
        path: candidate.path,
        reason: `read failed: ${(err as Error).message}`,
      });
      continue;
    }

    const tail = content.subarray(startByte);
    if (tail.byteLength === 0) {
      rawFilesSkipped.push({
        path: candidate.path,
        reason: "already consumed to watermark",
      });
      continue;
    }
    eligibleRaws.push({
      candidate,
      content,
      startByte,
      cursor: startByte,
      chunks: [],
      sortGroup: watermark ? 1 : 0,
      sortAtMs: watermark ? parseSortTime(watermark.lastObservationAt, candidate.mtimeMs) : candidate.mtimeMs,
    });
  }

  eligibleRaws.sort(compareEligibleRaw);

  // Defer files beyond the per-pass cap. Aging keeps these at the front of the
  // next pass; they still count toward the remaining backlog so `--drain` knows
  // there is more to do.
  const deferredRaws = eligibleRaws.splice(
    readPositiveInteger(opts.maxFilesPerPass, DEFAULT_MAX_FILES_PER_PASS, "maxFilesPerPass"),
  );
  for (const raw of deferredRaws) {
    rawFilesSkipped.push({
      path: raw.candidate.path,
      reason: "deferred to a later pass (max files per pass)",
    });
  }

  while (totalUsed < totalMaxBytes && perFileMaxBytes > 0) {
    let advanced = false;
    for (let index = 0; index < eligibleRaws.length; index += 1) {
      const raw = eligibleRaws[index]!;
      if (totalUsed >= totalMaxBytes) break;
      if (raw.cursor >= raw.content.byteLength) continue;
      const remaining = totalMaxBytes - totalUsed;
      const laterActiveCount = countActiveRawsAfter(eligibleRaws, index);
      const reservedForLater = Math.min(laterActiveCount, Math.max(0, remaining - 1));
      const maxBytes = Math.min(perFileMaxBytes, remaining - reservedForLater);
      const endByte = chooseSliceEnd(raw.content, raw.cursor, maxBytes);
      if (endByte <= raw.cursor) continue;
      const chunk = raw.content.subarray(raw.cursor, endByte);
      raw.chunks.push(chunk);
      raw.cursor = endByte;
      totalUsed += chunk.byteLength;
      advanced = true;
    }
    if (!advanced) break;
  }

  for (const raw of eligibleRaws) {
    const includedBytes = raw.cursor - raw.startByte;
    if (includedBytes <= 0) {
      if (totalUsed >= totalMaxBytes) {
        rawFilesSkipped.push({
          path: raw.candidate.path,
          reason: "totalMaxBytes reached",
        });
      } else if (raw.cursor < raw.content.byteLength) {
        rawFilesSkipped.push({
          path: raw.candidate.path,
          reason: "observation exceeds byte window",
        });
      }
      continue;
    }

    let text = Buffer.concat(raw.chunks).toString("utf-8");
    let truncationNotice = "";
    if (raw.cursor < raw.content.byteLength) {
      const remainingBytes = raw.content.byteLength - raw.cursor;
      truncationNotice += `\n\n[truncated; ${remainingBytes} raw byte(s) remain after fairness window]`;
      if (totalUsed >= totalMaxBytes) {
        truncationNotice += `\n\n[truncated at totalMaxBytes ${totalMaxBytes}]`;
      }
    }
    const originalText = text;
    const lastObservationAt = detectLastObservationAt(raw.candidate.relPath, originalText, raw.candidate.mtimeMs);
    if (rawFilterEnabled) {
      const filtered = filterRawText(text);
      filterStats.bytesIn += filtered.bytesIn;
      filterStats.bytesOut += filtered.bytesOut;
      filterStats.signalBytes += filtered.signalBytes;
      filterStats.rawBytesConsumed += includedBytes;
      filterStats.filesFiltered += 1;
      mergeStrippedByClass(filterStats.strippedByClass, filtered.strippedByClass);
      if (opts.filterReport) {
        filterReportFiles.push({
          path: raw.candidate.path,
          relPath: raw.candidate.relPath,
          bytesIn: filtered.bytesIn,
          bytesOut: filtered.bytesOut,
          reductionPct: reductionPct(filtered.bytesIn, filtered.bytesOut),
          signalBytes: filtered.signalBytes,
          rawBytesConsumed: includedBytes,
          noiseOnly: filtered.noiseOnly,
          strippedByClass: { ...filtered.strippedByClass },
        });
      }
      text = filtered.filtered;
      if (filtered.noiseOnly) {
        noiseOnlyWatermarks.push({
          relPath: raw.candidate.relPath,
          bytes: raw.cursor,
          lastObservationAt,
        });
        noiseOnlySkipped += 1;
        continue;
      }
    }
    text += truncationNotice;

    rawFilesIncluded.push(raw.candidate.path);
    includedWatermarks.push({
      relPath: raw.candidate.relPath,
      bytes: raw.cursor,
      lastObservationAt,
    });
    rawContentBlocks.push(
      `### ${raw.candidate.path}\n\n\`\`\`markdown\n${text}\n\`\`\``,
    );
  }

  const deferredBytesRemaining = deferredRaws.reduce(
    (sum, raw) => sum + Math.max(0, raw.content.byteLength - raw.startByte),
    0,
  );
  const rawBytesRemaining = eligibleRaws.reduce(
    (sum, raw) => sum + Math.max(0, raw.content.byteLength - raw.cursor),
    0,
  ) + deferredBytesRemaining;
  const rawFilesRemaining =
    eligibleRaws.filter((raw) => raw.cursor < raw.content.byteLength).length + deferredRaws.length;
  truncatedAtTotalCap = rawBytesRemaining > 0 && (totalUsed >= totalMaxBytes || deferredRaws.length > 0);

  if (opts.filterReport) {
    return {
      prompt: "",
      rawFilesIncluded,
      rawRelPathsIncluded: includedWatermarks.map((item) => item.relPath),
      rawFilesSkipped,
      sinceCutoff: sinceDate.toISOString(),
      watermarkMode,
      watermarksAdvanced: [],
      pendingSummary: await summarizeCompilePending(root, compileState),
      truncatedAtTotalCap,
      rawBytesRemaining,
      rawFilesRemaining,
      noiseOnlySkipped,
      filterStats,
      filterReport: buildCompileFilterReport(filterReportFiles, filterStats),
    };
  }

  const prompt = renderPrompt(promptTemplate, {
    schema_content: schema,
    index_content: index,
    existing_pages: await buildExistingPagesContext(
      root,
      rawContentBlocks.join("\n\n"),
      existingPagesMaxBytes,
    ),
    recent_log_lines: tailLines(log, 50),
    raw_files_list:
      rawFilesIncluded.length === 0
        ? "(none)"
        : rawFilesIncluded.map((path) => `- ${path}`).join("\n"),
    raw_content:
      rawContentBlocks.length === 0 ? "(none)" : rawContentBlocks.join("\n\n"),
  });

  if (opts.outputPath) {
    await mkdir(dirname(opts.outputPath), { recursive: true });
    await writeFile(opts.outputPath, prompt);
  }

  const execution = opts.execute
    ? await executeCompilePrompt({ ...opts, root, prompt, hasRawContent: rawContentBlocks.length > 0 })
    : undefined;
  const watermarksAdvanced = await maybeAdvanceWatermarks({
    root,
    watermarkMode,
    plan: opts.plan,
    execute: opts.execute,
    execution,
    includedWatermarks,
    noiseOnlyWatermarks,
  });
  if (watermarksAdvanced.length > 0) {
    await clearOpsJournal(root);
  }
  if (rawFilterEnabled && filterStats.filesFiltered > 0) {
    await persistLastFilterStats(root, filterStats);
  }
  const indexRebuild = execution?.mode === "execute" && !opts.plan
    && execution.applied.length + execution.proposed.length > 0
    ? await rebuildIndex(root)
    : undefined;
  const pendingSummary = await summarizeCompilePending(
    root,
    watermarksAdvanced.length > 0 ? await readCompileStateForCompile(root) : compileState,
  );

  return {
    prompt,
    rawFilesIncluded,
    rawRelPathsIncluded: includedWatermarks.map((item) => item.relPath),
    rawFilesSkipped,
    sinceCutoff: sinceDate.toISOString(),
    watermarkMode,
    ...(watermarkReset ? { watermarkReset } : {}),
    watermarksAdvanced,
    pendingSummary,
    truncatedAtTotalCap,
    rawBytesRemaining,
    rawFilesRemaining,
    noiseOnlySkipped,
    execution,
    ...(indexRebuild ? { indexRebuild } : {}),
    ...(rawFilterEnabled ? { filterStats } : {}),
  };
}

export function formatCompileExecuteSummary(result: CompileResult): string[] {
  const execution = result.execution;
  if (!execution) return [];
  const pending = result.pendingSummary;
  const lines = [
    `Consolidated ${formatNumber(result.rawFilesIncluded.length)} observations -> ${formatNumber(execution.applied.length)} applied, ${formatNumber(execution.proposed.length)} staged, ${formatNumber(execution.rejected.length)} rejected.`,
    `Pending tails: ${formatNumber(pending.filesWithPendingTail)} ${plural(pending.filesWithPendingTail, "raw file")} ${pending.filesWithPendingTail === 1 ? "has" : "have"} fresh content since the last compile read them (${formatNumber(pending.pendingTailBytes)} ${plural(pending.pendingTailBytes, "byte")}).`,
    `Already-drained: ${formatNumber(pending.filesFullyDrained)} ${plural(pending.filesFullyDrained, "raw file")} ${pending.filesFullyDrained === 1 ? "has" : "have"} no new bytes since the last pass.`,
    `Future batches: ${formatNumber(result.rawFilesRemaining)} ${plural(result.rawFilesRemaining, "raw file")} queued for upcoming runs (batch cap ${DEFAULT_MAX_FILES_PER_PASS}).`,
    `${formatNumber(execution.sessionsScanned)} ${plural(execution.sessionsScanned, "session")} scanned. ${formatNumber(execution.pagesUnchanged)} ${plural(execution.pagesUnchanged, "page")} unchanged.`,
  ];
  return lines;
}

export function formatCompileFilterReport(report: CompileFilterReport): string {
  const lines = [
    "Compile raw filter report",
    `  files:             ${report.aggregate.files}`,
    `  bytes in:          ${report.aggregate.bytesIn}`,
    `  bytes out:         ${report.aggregate.bytesOut}`,
    `  reduction:         ${report.aggregate.reductionPct}%`,
    `  signal bytes:      ${report.aggregate.signalBytes}`,
    `  noise-only files:  ${report.aggregate.noiseOnlyFiles}`,
  ];
  const classes = Object.entries(report.aggregate.strippedByClass)
    .sort(([a], [b]) => a.localeCompare(b));
  if (classes.length > 0) {
    lines.push("  stripped classes:");
    for (const [className, bytes] of classes) {
      lines.push(`    - ${className}: ${bytes}`);
    }
  }
  if (report.perFile.length > 0) {
    lines.push("  files:");
    for (const item of report.perFile) {
      lines.push(`    - ${item.relPath}: ${item.bytesIn} -> ${item.bytesOut} (${item.reductionPct}%, signal ${item.signalBytes}, noiseOnly ${item.noiseOnly ? "yes" : "no"})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runCompileDrain(
  opts: CompileDrainOptions,
): Promise<CompileDrainResult> {
  if (!opts.execute) {
    throw new Error("memory compile: --drain requires --execute");
  }
  if (opts.plan) {
    throw new Error("memory compile: --drain cannot be combined with --plan");
  }
  const maxPasses = readPositiveInteger(opts.maxPasses, 50, "maxPasses");
  if (maxPasses < 1) {
    throw new Error("memory compile: maxPasses must be at least 1");
  }

  const passes: CompileResult[] = [];
  let totalRawFilesIncluded = 0;
  let totalWatermarksAdvanced = 0;
  let consecutiveStalls = 0;
  let consecutiveErrors = 0;
  const retryDelaysMs = [30_000, 60_000, 120_000, 240_000, 480_000];
  const quarantined = new Set<string>(opts.excludeRawPaths ?? []);
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    let result: CompileResult;
    try {
      result = await runCompile({
        ...opts,
        execute: true,
        plan: false,
        skipFactConsolidation: true,
        excludeRawPaths: quarantined,
      });
      consecutiveErrors = 0;
    } catch (error) {
      // Transient failures (LM Link drops, provider hiccups) must not kill a
      // multi-day drain. Back off and retry; give up only after the full
      // backoff ladder fails consecutively.
      const message = error instanceof Error ? error.message : String(error);
      const delayMs = retryDelaysMs[Math.min(consecutiveErrors, retryDelaysMs.length - 1)]!;
      consecutiveErrors += 1;
      if (consecutiveErrors > retryDelaysMs.length) throw error;
      opts.onProgress?.(
        `pass ${pass} failed (${message}); retry ${consecutiveErrors}/${retryDelaysMs.length} in ${Math.round(delayMs / 1000)}s`,
        null,
        pass,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      pass -= 1;
      continue;
    }
    passes.push(result);
    totalRawFilesIncluded += result.rawFilesIncluded.length;
    totalWatermarksAdvanced += result.watermarksAdvanced.length;
    const progressLine = formatDrainProgress(pass, result);
    opts.onProgress?.(progressLine, result, pass);
    if (result.rawFilesIncluded.length === 0 && result.noiseOnlySkipped === 0) {
      return {
        passes,
        stopReason: "empty",
        totalRawFilesIncluded,
        totalWatermarksAdvanced,
        rawBytesRemaining: result.rawBytesRemaining,
        rawFilesRemaining: result.rawFilesRemaining,
        quarantinedRawPaths: [...quarantined],
      };
    }
    // Files were included but no watermark moved — the same batch would be
    // re-sent next pass. Retry once (transient LLM flakiness), then quarantine
    // the batch for the rest of this run so the drain moves on to other files.
    // Quarantined files keep their watermarks and are retried on the next run.
    const madeProgress = result.watermarksAdvanced.length > 0 || result.noiseOnlySkipped > 0;
    if (!madeProgress) {
      consecutiveStalls += 1;
      if (consecutiveStalls >= 2) {
        for (const relPath of result.rawRelPathsIncluded) quarantined.add(relPath);
        opts.onProgress?.(
          `quarantined ${result.rawRelPathsIncluded.length} file(s) after repeated no-progress passes; continuing with the rest`,
          result,
          pass,
        );
        consecutiveStalls = 0;
      }
    } else {
      consecutiveStalls = 0;
    }
  }

  const last = passes.at(-1);
  return {
    passes,
    stopReason: "max-passes",
    totalRawFilesIncluded,
    totalWatermarksAdvanced,
    rawBytesRemaining: last?.rawBytesRemaining ?? 0,
    rawFilesRemaining: last?.rawFilesRemaining ?? 0,
    quarantinedRawPaths: [...quarantined],
  };
}

function compareEligibleRaw(a: EligibleRaw, b: EligibleRaw): number {
  return a.sortGroup - b.sortGroup
    || a.sortAtMs - b.sortAtMs
    || a.candidate.mtimeMs - b.candidate.mtimeMs
    || a.candidate.path.localeCompare(b.candidate.path);
}

function parseSortTime(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function countActiveRawsAfter(raws: EligibleRaw[], index: number): number {
  let count = 0;
  for (let i = index + 1; i < raws.length; i += 1) {
    if (raws[i]!.cursor < raws[i]!.content.byteLength) count += 1;
  }
  return count;
}

function mergeStrippedByClass(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function buildCompileFilterReport(
  perFile: CompileFilterReportFile[],
  stats: CompileFilterStats,
): CompileFilterReport {
  return {
    perFile,
    aggregate: {
      files: perFile.length,
      bytesIn: stats.bytesIn,
      bytesOut: stats.bytesOut,
      reductionPct: reductionPct(stats.bytesIn, stats.bytesOut),
      signalBytes: stats.signalBytes,
      rawBytesConsumed: stats.rawBytesConsumed,
      noiseOnlyFiles: perFile.filter((item) => item.noiseOnly).length,
      strippedByClass: { ...stats.strippedByClass },
    },
  };
}

function reductionPct(bytesIn: number, bytesOut: number): number {
  if (bytesIn <= 0) return 0;
  return Math.round((1 - bytesOut / bytesIn) * 10_000) / 100;
}

async function persistLastFilterStats(root: string, stats: CompileFilterStats): Promise<void> {
  const at = new Date().toISOString();
  const runId = randomUUID();
  await mutateCompileStateFile(root, (state) => ({
    ...state,
    lastFilterStats: {
      bytesIn: stats.bytesIn,
      bytesOut: stats.bytesOut,
      rawBytesConsumed: stats.rawBytesConsumed,
      strippedByClass: { ...stats.strippedByClass },
      runId,
      at,
    },
  }));
}

function chooseSliceEnd(content: Buffer, startByte: number, maxBytes: number): number {
  if (maxBytes <= 0) return startByte;
  const hardEnd = Math.min(content.byteLength, startByte + maxBytes);
  if (hardEnd >= content.byteLength) return content.byteLength;

  const nextBoundary = findObservationBoundaryAfter(content, startByte);
  if (nextBoundary !== null && nextBoundary <= hardEnd) {
    return nextBoundary;
  }
  return backtrackUtf8Boundary(content, startByte, hardEnd);
}

function backtrackUtf8Boundary(content: Buffer, startByte: number, endByte: number): number {
  let end = endByte;
  while (end > startByte && end < content.byteLength && (content[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return end;
}

function findObservationBoundaryAfter(content: Buffer, startByte: number): number | null {
  const marker = Buffer.from("\n## [", "utf-8");
  const index = content.indexOf(marker, startByte + 1);
  return index === -1 ? null : index + 1;
}

function isObservationBoundaryAt(content: Buffer, startByte: number): boolean {
  const heading = Buffer.from("## [", "utf-8");
  if (startByte === 0) return content.subarray(0, heading.byteLength).equals(heading);
  const marker = Buffer.from("\n## [", "utf-8");
  const markerStart = startByte - 1;
  if (markerStart < 0) return false;
  return content.subarray(markerStart, markerStart + marker.byteLength).equals(marker);
}

function formatDrainProgress(pass: number, result: CompileResult): string {
  return [
    `pass ${pass}: included ${result.rawFilesIncluded.length} raw file(s)`,
    `advanced ${result.watermarksAdvanced.length} watermark(s)`,
    `remaining ${result.rawBytesRemaining} byte(s) in ${result.rawFilesRemaining} file(s)`,
  ].join(", ");
}

async function executeCompilePrompt(opts: CompileOptions & {
  root: string;
  prompt: string;
  hasRawContent: boolean;
}): Promise<CompileResult["execution"]> {
  const env = opts.env ?? process.env;
  const config = await (opts.configLoader ?? (() => loadMemoryConfig(opts.root)))();
  const llmConfig = getActiveLLMConfig(config);
  const llm = (opts.llmFactory ?? createLLMFromConfig)(llmConfig, env);
  const compressedFacts = opts.skipFactConsolidation ? [] : await loadCompressedFacts(opts.root);
  if (!opts.plan && compressedFacts.length > 0) {
    const result = await runFactConsolidation({
      vaultRoot: opts.root,
      llm,
    });
    const consolidationDidWork =
      result.applied.length > 0 || result.proposed.length > 0;
    if (consolidationDidWork) {
      return {
        ...result,
        rawInputConsumed: false,
      };
    }
    // Nothing to consolidate — fall through to prompt-based raw execution.
    // A permanently non-empty facts store must not starve the wiki: without
    // this fallthrough, leftover facts shadow the raw path on every run and
    // the compile watermark never advances.
  }
  if (!opts.hasRawContent) {
    return {
      mode: opts.plan ? "plan" : "execute",
      rawInputConsumed: false,
      applied: [],
      proposed: [],
      planned: [],
      rejected: [],
      outcomes: [],
      referencesStripped: 0,
      prosePathLeaks: 0,
      pagesRewritten: 0,
      pagesUpdated: 0,
      pagesUnchanged: 0,
      factsExtracted: 0,
      sessionsScanned: 0,
    };
  }
  const response = await chatWithAudit({
    llm,
    vaultRoot: opts.root,
    consumer: "compile-execute",
    request: {
      messages: [
        {
          role: "system",
          content: "Return only a fenced compile-ops JSON block describing grounded memory mutations. Prefer rewrite_page for existing-page knowledge consolidation.",
        },
        { role: "user", content: opts.prompt },
      ],
      maxTokens: llmConfig?.max_tokens,
      temperature: llmConfig?.temperature,
    },
    env,
  });
  const parsed = parseCompileOperationsBlock(response.content);
  if (!parsed.ok) {
    return {
      mode: opts.plan ? "plan" : "execute",
      rawInputConsumed: true,
      applied: [],
      proposed: [],
      planned: [],
      rejected: [{ path: "(response)", reason: parsed.reason }],
      outcomes: [{
        path: "(response)",
        outcome: "rejected",
        reason: parsed.reason,
        contentPreserved: false,
      }],
      referencesStripped: 0,
      prosePathLeaks: 0,
      pagesRewritten: 0,
      pagesUpdated: 0,
      pagesUnchanged: 0,
      factsExtracted: 0,
      sessionsScanned: 0,
    };
  }
  const applied = await applyCompileOperations({
    vaultRoot: opts.root,
    operations: parsed.operations,
    plan: opts.plan,
    rewriteLLM: opts.plan ? undefined : llm,
    extractFacts: false,
    journal: !opts.plan,
  });
  return {
    mode: opts.plan ? "plan" : "execute",
    rawInputConsumed: true,
    ...applied,
  };
}

async function listRawFiles(vaultRoot: string, rawRoot: string): Promise<RawCandidate[]> {
  if (!existsSync(rawRoot)) return [];
  const files: RawCandidate[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const info = await stat(full);
        files.push({
          path: full,
          relPath: relativeVaultPath(vaultRoot, full),
          mtimeMs: info.mtimeMs,
          size: info.size,
        });
      }
    }
  }

  await walk(rawRoot);
  return files.sort(
    (a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path),
  );
}

async function buildExistingPagesContext(vaultRoot: string, rawContent: string, maxBytes: number): Promise<string> {
  if (maxBytes === 0) return "(none)";
  const wikiRoot = join(vaultRoot, "wiki");
  if (!existsSync(wikiRoot)) return "(none)";
  const pages: Array<{ relPath: string; body: string; score: number }> = [];
  for (const fullPath of await listWikiPageFiles(wikiRoot)) {
    const relPath = `wiki/${relative(wikiRoot, fullPath).replace(/\\/g, "/")}`;
    const parsed = parseFrontmatter(await readFile(fullPath, "utf-8"));
    const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : "";
    const body = parsed.body.trim();
    pages.push({
      relPath,
      body,
      score: scoreExistingPageReference(rawContent, relPath, title),
    });
  }
  pages.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));

  const blocks: string[] = [];
  let used = 0;
  for (const page of pages) {
    const block = `### ${page.relPath}\n\n\`\`\`markdown\n${page.body}\n\`\`\``;
    const bytes = Buffer.byteLength(block, "utf-8") + (blocks.length > 0 ? 2 : 0);
    if (used + bytes > maxBytes) continue;
    blocks.push(block);
    used += bytes;
  }
  return blocks.length > 0 ? blocks.join("\n\n") : "(none)";
}

async function listWikiPageFiles(wikiRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(wikiRoot, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (isExcludedWikiContextPath(relPath)) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md") && !isExcludedWikiContextPath(relPath)) {
        files.push(fullPath);
      }
    }
  }
  await walk(wikiRoot);
  return files.sort((a, b) => a.localeCompare(b));
}

function isExcludedWikiContextPath(relPath: string): boolean {
  return relPath
    .split("/")
    .some((part) => part === ".audit" || part === "archive" || part.endsWith("-proposed"));
}

function scoreExistingPageReference(rawContent: string, relPath: string, title: string): number {
  const haystack = rawContent.toLowerCase();
  const slug = relPath.split("/").at(-1)?.replace(/\.md$/i, "") ?? "";
  return countOccurrences(haystack, title.toLowerCase())
    + countOccurrences(haystack, slug.toLowerCase().replace(/-/g, " "))
    + countOccurrences(haystack, slug.toLowerCase())
    + countOccurrences(haystack, relPath.toLowerCase());
}

function countOccurrences(text: string, needle: string): number {
  const value = needle.trim();
  if (!value) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(value, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + value.length;
  }
}

async function maybeAdvanceWatermarks(opts: {
  root: string;
  watermarkMode: CompileResult["watermarkMode"];
  plan?: boolean;
  execute?: boolean;
  execution?: CompileResult["execution"];
  includedWatermarks: IncludedRawWatermark[];
  noiseOnlyWatermarks?: IncludedRawWatermark[];
}): Promise<string[]> {
  if (opts.watermarkMode !== "gated") return [];
  if (opts.plan) return [];
  const advanced: IncludedRawWatermark[] = [];
  if (opts.execute && opts.noiseOnlyWatermarks && opts.noiseOnlyWatermarks.length > 0) {
    advanced.push(...opts.noiseOnlyWatermarks);
  }
  if (
    opts.execution
    && opts.execution.mode === "execute"
    && opts.execution.rawInputConsumed !== false
    && opts.execution.applied.length + opts.execution.proposed.length > 0
    && opts.includedWatermarks.length > 0
  ) {
    advanced.push(...opts.includedWatermarks);
  }
  if (advanced.length === 0) return [];

  await mutateCompileStateFile(opts.root, (state) => {
    const consumed = readConsumedMap(state);
    for (const included of advanced) {
      consumed[included.relPath] = {
        bytes: included.bytes,
        lastObservationAt: included.lastObservationAt,
      };
    }
    return { ...state, consumed };
  });
  return advanced.map((item) => item.relPath);
}

async function resetConsumedWatermarks(
  root: string,
  state: CompileStateFile,
  resetWatermark: string | boolean,
): Promise<{ pattern: string | null; cleared: number }> {
  const consumed = readConsumedMap(state);
  const pattern = typeof resetWatermark === "string" ? resetWatermark.replace(/\\/g, "/") : null;
  const before = Object.keys(consumed).length;
  if (!pattern) {
    for (const key of Object.keys(consumed)) delete consumed[key];
  } else {
    const matches = globMatcher(pattern);
    for (const key of Object.keys(consumed)) {
      if (matches(key)) delete consumed[key];
    }
  }
  const cleared = before - Object.keys(consumed).length;
  await mutateCompileStateFile(root, (fresh) => ({ ...fresh, consumed }));
  return { pattern, cleared };
}

async function readCompileStateForCompile(
  root: string,
  opts: { migrateLegacy?: boolean } = {},
): Promise<CompileStateFile> {
  try {
    return await readCompileStateFile(root, opts);
  } catch {
    return {};
  }
}

function globMatcher(pattern: string): (value: string) => boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");
  const re = new RegExp(`^${escaped}$`);
  return (value) => re.test(value.replace(/\\/g, "/"));
}

function relativeVaultPath(vaultRoot: string, fullPath: string): string {
  return relative(vaultRoot, fullPath).replace(/\\/g, "/");
}

function detectLastObservationAt(relPath: string, text: string, fallbackMtimeMs: number): string {
  const date = /^raw\/(\d{4}-\d{2}-\d{2})\//.exec(relPath)?.[1];
  let latest: string | null = null;
  const timeRe = /^## \[(\d{2}:\d{2}:\d{2})\]/gm;
  let match: RegExpExecArray | null;
  while ((match = timeRe.exec(text)) !== null) {
    if (date) latest = `${date}T${match[1]}Z`;
  }
  if (latest) return new Date(latest).toISOString();
  return new Date(fallbackMtimeMs).toISOString();
}

function detectSinceFromLog(log: string): Date | null {
  let latest: Date | null = null;
  let match: RegExpExecArray | null;
  COMPILE_LOG_RE.lastIndex = 0;
  while ((match = COMPILE_LOG_RE.exec(log)) !== null) {
    const parsed = parseCutoff(`${match[1]}T${match[2]}Z`);
    if (!latest || parsed > latest) latest = parsed;
  }
  return latest;
}

function parseCutoff(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`memory compile: invalid --since value: ${value}`);
  }
  return parsed;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return count === 1 ? singular : pluralValue;
}

async function readRequiredFile(path: string, label: string): Promise<string> {
  if (!existsSync(path)) {
    throw new Error(`memory compile: missing ${label} at ${path}`);
  }
  return readFile(path, "utf-8");
}

async function readOptionalFile(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  return readFile(path, "utf-8");
}

function readPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`memory compile: ${name} must be a non-negative integer`);
  }
  return n;
}

function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (full, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : full;
  });
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}
