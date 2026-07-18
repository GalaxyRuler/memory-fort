import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { mutateCompileStateFile, readCompressedMap, readCompileStateFile, writeCompileStateFile } from "../../compile/state.js";
import { createLLMFromConfig, getActiveLLMConfig, type LLMConfig } from "../../llm/factory.js";
import { estimateLLMCostUsd } from "../../llm/pricing.js";
import type { LLMProvider, LLMTokenUsage } from "../../llm/types.js";
import { loadMemoryConfig, type MemoryConfig } from "../../storage/config.js";
import { memoryRoot } from "../../storage/paths.js";
import { listRawMarkdownFiles } from "../../storage/raw-walker.js";
import {
  CURRENT_COMPRESS_VERSION,
  DEFAULT_COMPRESS_CHUNK_THRESHOLD_BYTES,
  DEFAULT_COMPRESS_MAX_CALL_TOKENS,
  DEFAULT_COMPRESS_MAX_CHUNKS,
  DEFAULT_COMPRESS_MAX_INPUT_BYTES,
  addTokenUsage,
  compressSessionWithUsage,
  mergeCompressedFacts,
  resolveMaxBytesPerCall,
} from "../../facts/compress.js";
import {
  factFileRelPath,
  readCompressedFactFile,
  writeCompressedFactFile,
  type CompressedFact,
} from "../../facts/store.js";

export interface CompressOptions {
  vaultRoot?: string;
  apply?: boolean;
  drain?: boolean;
  maxSessions?: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  configLoader?: () => Promise<MemoryConfig>;
  llmFactory?: (config: LLMConfig | null, env: NodeJS.ProcessEnv) => LLMProvider;
  logger?: (line: string) => void;
}

export interface CompressResult {
  mode: "plan" | "apply";
  files: Array<{
    path: string;
    outcome: "compressed" | "skipped" | "planned" | "failed";
    facts: number;
    factPath?: string;
    reason?: string;
    inputTokens?: number;
    chunksCompressed?: number;
    totalChunks?: number;
    sampledChunks?: number;
  }>;
  summary: {
    scanned: number;
    compressed: number;
    skipped: number;
    failed: number;
    factsWritten: number;
  };
  tokensUsed?: LLMTokenUsage;
  cost?: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    estimatedUsd: number | null;
  };
}

const DEFAULT_MAX_SESSIONS = 25;

export async function runCompress(opts: CompressOptions = {}): Promise<CompressResult> {
  const root = opts.vaultRoot ?? memoryRoot();
  const mode = opts.apply ? "apply" : "plan";
  const rawFiles = await listRawMarkdownFiles(root);
  const state = await readCompileStateFile(root);
  const compressed = readCompressedMap(state);
  const maxSessions = positiveInteger(opts.maxSessions, DEFAULT_MAX_SESSIONS);
  const files: CompressResult["files"] = [];
  let tokensUsed: LLMTokenUsage | undefined;

  let llm: LLMProvider | undefined;
  let compressConfig = defaultCompressConfig();
  if (mode === "apply") {
    const env = opts.env ?? process.env;
    const config = await (opts.configLoader ?? (() => loadMemoryConfig(root)))();
    compressConfig = compressConfigFromMemoryConfig(config);
    llm = (opts.llmFactory ?? createLLMFromConfig)(getActiveLLMConfig(config), env);
  }

  const currentChunkBytes = resolveMaxBytesPerCall({
    maxInputBytes: compressConfig.maxInputBytes,
    chunkThresholdBytes: compressConfig.chunkThresholdBytes,
    maxCallTokens: compressConfig.maxCallTokens,
  });

  for (const raw of rawFiles) {
    const info = await stat(raw.fullPath);
    const watermark = compressed[raw.relPath];
    const versionMatches = watermark?.compressVersion === CURRENT_COMPRESS_VERSION;
    const bytesMatch = watermark?.bytes === info.size;
    const complete = versionMatches && bytesMatch
      && (watermark!.chunkTotal === undefined || (watermark!.chunkCursor ?? 0) >= watermark!.chunkTotal);
    if (complete) {
      files.push({ path: raw.relPath, outcome: "skipped", facts: 0, reason: "already compressed" });
      continue;
    }
    if (files.filter((file) => file.outcome === "compressed" || file.outcome === "planned" || file.outcome === "failed").length >= maxSessions) {
      files.push({ path: raw.relPath, outcome: "skipped", facts: 0, reason: "deferred to a later compress pass" });
      continue;
    }
    if (mode === "plan") {
      files.push({ path: raw.relPath, outcome: "planned", facts: 0 });
      continue;
    }
    if (!llm) throw new Error("memory compress: LLM is required in apply mode");
    try {
      const rawText = await readFile(raw.fullPath, "utf-8");
      const sessionId = readSessionId(rawText) ?? basename(raw.relPath, ".md");
      const observedAt = observedAtFromRaw(raw.relPath, info.mtimeMs);
      const factRelPath = factFileRelPath(raw.relPath, sessionId);

      // Resume only when the file bytes AND the chunking fingerprint are
      // unchanged — chunk boundaries derive from maxBytesPerCall, so a config
      // change makes a stored cursor point into a different chunking.
      let startChunk = versionMatches && bytesMatch
        && watermark!.chunkBytes === currentChunkBytes
        ? (watermark!.chunkCursor ?? 0)
        : 0;

      // Load the prior fact artifact with STRICT validation: it must parse AND
      // every member of its facts array must survive the reader. A parseable
      // file whose members are filtered out ({"facts":[{}]}) is corruption —
      // resuming onto it would advance the cursor over lost earlier windows.
      let priorFacts: CompressedFact[] = [];
      let priorValid = false;
      const priorAbs = join(root, ...factRelPath.split("/"));
      if (existsSync(priorAbs)) {
        try {
          const priorRaw = await readFile(priorAbs, "utf-8");
          const parsed: unknown = JSON.parse(priorRaw);
          if (parsed && typeof parsed === "object" && Array.isArray((parsed as { facts?: unknown }).facts)) {
            const rawCount = (parsed as { facts: unknown[] }).facts.length;
            priorFacts = readCompressedFactFile(priorRaw);
            priorValid = priorFacts.length === rawCount;
            if (!priorValid) priorFacts = [];
          }
        } catch {
          // malformed prior fact file — treated as absent
        }
      }
      // Conservation: never resume without a strictly valid prior artifact.
      if (startChunk > 0 && !priorValid) startChunk = 0;

      const result = await compressSessionWithUsage({
        rawText,
        rawRelPath: raw.relPath,
        sessionId,
        observedAt,
        llm,
        maxInputBytes: compressConfig.maxInputBytes,
        chunkThresholdBytes: compressConfig.chunkThresholdBytes,
        maxChunks: compressConfig.maxChunks,
        maxCallTokens: compressConfig.maxCallTokens,
        vaultRoot: root,
        env: opts.env,
        now: opts.now,
        logger: opts.logger,
        startChunk,
      });

      // Merge with a valid prior artifact on BOTH resume and restart. A restart
      // (compaction changed the bytes, config changed the chunking) reprocesses
      // the live content, but the prior facts may have been extracted from
      // richer, since-compacted content — overwriting them would make those
      // facts unreachable from every normal pipeline path (the archive copy is
      // excluded by the raw walker). mergeCompressedFacts dedupes overlaps.
      const mergedFacts = priorValid && priorFacts.length > 0
        ? mergeCompressedFacts([...priorFacts, ...result.facts])
        : result.facts;
      const isComplete = result.chunkCursor >= result.totalChunks;
      // Completed files report full coverage and drop per-fact sampling markers
      // left over from intermediate passes — a converged artifact must not read
      // as partially sampled.
      const finalFacts = isComplete
        ? mergedFacts.map(({ sampledChunks: _s, totalChunks: _t, ...rest }) => rest as CompressedFact)
        : mergedFacts;
      const factPath = await writeCompressedFactFile(root, {
        version: 1,
        sourceRawPath: raw.relPath,
        sessionId,
        observedAt,
        compressedAt: (opts.now ?? new Date()).toISOString(),
        inputTokens: result.inputTokens,
        chunksCompressed: isComplete ? result.totalChunks : result.chunksCompressed,
        totalChunks: result.totalChunks,
        ...(!isComplete && result.sampledChunks !== undefined ? { sampledChunks: result.sampledChunks } : {}),
        facts: finalFacts,
      });
      compressed[raw.relPath] = {
        bytes: info.size,
        lastObservationAt: observedAt,
        compressVersion: CURRENT_COMPRESS_VERSION,
        ...(isComplete
          ? {}
          : { chunkCursor: result.chunkCursor, chunkTotal: result.totalChunks, chunkBytes: result.chunkBytes }),
      };
      files.push({
        path: raw.relPath,
        outcome: "compressed",
        facts: finalFacts.length,
        factPath,
        inputTokens: result.inputTokens,
        // On completion report full coverage, not just the final window, so the
        // command result and formatter match the persisted artifact.
        chunksCompressed: isComplete ? result.totalChunks : result.chunksCompressed,
        totalChunks: result.totalChunks,
        ...(!isComplete && result.sampledChunks !== undefined ? { sampledChunks: result.sampledChunks } : {}),
      });
      tokensUsed = addTokenUsage(tokensUsed, result.tokensUsed);
    } catch (err) {
      files.push({ path: raw.relPath, outcome: "failed", facts: 0, reason: errorMessage(err) });
    }
  }

  if (mode === "apply") {
    await mutateCompileStateFile(root, (fresh) => ({ ...fresh, compressed }));
  }

  return {
    mode,
    files,
    summary: {
      scanned: rawFiles.length,
      compressed: files.filter((file) => file.outcome === "compressed").length,
      skipped: files.filter((file) => file.outcome === "skipped").length,
      failed: files.filter((file) => file.outcome === "failed").length,
      factsWritten: files.reduce((sum, file) => sum + (file.outcome === "compressed" ? file.facts : 0), 0),
    },
    ...(tokensUsed ? { tokensUsed } : {}),
    ...(tokensUsed && llm
      ? {
          cost: {
            totalTokens: tokensUsed.total,
            promptTokens: tokensUsed.prompt,
            completionTokens: tokensUsed.completion,
            estimatedUsd: estimateLLMCostUsd({
              provider: llm.providerName,
              model: llm.modelName,
              tokensIn: tokensUsed.prompt,
              tokensOut: tokensUsed.completion,
            }),
          },
        }
      : {}),
  };
}

export function formatCompressResult(result: CompressResult): string {
  const lines = [
    `Memory compress ${result.mode} complete`,
    `  scanned:      ${result.summary.scanned}`,
    `  compressed:   ${result.summary.compressed}`,
    `  skipped:      ${result.summary.skipped}`,
    `  failed:       ${result.summary.failed}`,
    `  facts written: ${result.summary.factsWritten}`,
  ];
  if (result.tokensUsed) {
    lines.push(`  tokens:       ${result.tokensUsed.total} total (${result.tokensUsed.prompt} prompt, ${result.tokensUsed.completion} completion)`);
  }
  if (result.cost) {
    const estimated = result.cost.estimatedUsd === null ? "unknown" : `$${result.cost.estimatedUsd.toFixed(4)}`;
    lines.push(`  compress.cost: ${result.cost.totalTokens} tokens, est. ${estimated}`);
  }
  for (const file of result.files) {
    const metadata = file.outcome === "compressed"
      ? [
          file.inputTokens !== undefined ? `${file.inputTokens} input tokens` : "",
          file.totalChunks !== undefined ? `chunks ${file.chunksCompressed ?? 0}/${file.totalChunks}` : "",
          file.sampledChunks !== undefined ? "sampled" : "",
        ].filter(Boolean).join(", ")
      : "";
    lines.push(`  - ${file.outcome}: ${file.path}${file.factPath ? ` -> ${file.factPath}` : ""}${metadata ? ` (${metadata})` : ""}${file.reason ? ` (${file.reason})` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}


function readSessionId(rawText: string): string | null {
  return /^session:\s*"?([^"\n]+)"?\s*$/m.exec(rawText)?.[1]?.trim() ?? null;
}

function observedAtFromRaw(relPath: string, fallbackMtimeMs: number): string {
  const date = /^raw\/(\d{4}-\d{2}-\d{2})\//.exec(relPath)?.[1];
  if (date) return new Date(`${date}T00:00:00.000Z`).toISOString();
  return new Date(fallbackMtimeMs).toISOString();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function defaultCompressConfig(): {
  maxInputBytes: number;
  chunkThresholdBytes: number;
  maxChunks: number;
  maxCallTokens: number;
} {
  return {
    maxInputBytes: DEFAULT_COMPRESS_MAX_INPUT_BYTES,
    chunkThresholdBytes: DEFAULT_COMPRESS_CHUNK_THRESHOLD_BYTES,
    maxChunks: DEFAULT_COMPRESS_MAX_CHUNKS,
    maxCallTokens: DEFAULT_COMPRESS_MAX_CALL_TOKENS,
  };
}

function compressConfigFromMemoryConfig(config: MemoryConfig): ReturnType<typeof defaultCompressConfig> {
  const defaults = defaultCompressConfig();
  const compress = typeof config.compress === "object" && config.compress !== null && !Array.isArray(config.compress)
    ? config.compress
    : {};
  return {
    maxInputBytes: positiveInteger(asNumber(compress["max_input_bytes"]), defaults.maxInputBytes),
    chunkThresholdBytes: positiveInteger(asNumber(compress["chunk_threshold_bytes"]), defaults.chunkThresholdBytes),
    maxChunks: positiveInteger(asNumber(compress["max_chunks"]), defaults.maxChunks),
    maxCallTokens: positiveInteger(asNumber(compress["max_call_tokens"]), defaults.maxCallTokens),
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}
