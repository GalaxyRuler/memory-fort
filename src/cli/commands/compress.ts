import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { readCompressedMap, readCompileStateFile, writeCompileStateFile } from "../../compile/state.js";
import { createLLMFromConfig, getActiveLLMConfig, type LLMConfig } from "../../llm/factory.js";
import { estimateLLMCostUsd } from "../../llm/pricing.js";
import type { LLMProvider, LLMTokenUsage } from "../../llm/types.js";
import { loadMemoryConfig, type MemoryConfig } from "../../storage/config.js";
import { memoryRoot } from "../../storage/paths.js";
import {
  CURRENT_COMPRESS_VERSION,
  DEFAULT_COMPRESS_CHUNK_THRESHOLD_BYTES,
  DEFAULT_COMPRESS_MAX_CALL_TOKENS,
  DEFAULT_COMPRESS_MAX_CHUNKS,
  DEFAULT_COMPRESS_MAX_INPUT_BYTES,
  addTokenUsage,
  compressSessionWithUsage,
} from "../../facts/compress.js";
import { writeCompressedFactFile } from "../../facts/store.js";

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
  const rawRoot = join(root, "raw");
  const rawFiles = await listRawFiles(root, rawRoot);
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

  for (const raw of rawFiles) {
    const info = await stat(raw.fullPath);
    const watermark = compressed[raw.relPath];
    if (watermark?.bytes === info.size && watermark.compressVersion === CURRENT_COMPRESS_VERSION) {
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
      });
      const factPath = await writeCompressedFactFile(root, {
        version: 1,
        sourceRawPath: raw.relPath,
        sessionId,
        observedAt,
        compressedAt: (opts.now ?? new Date()).toISOString(),
        inputTokens: result.inputTokens,
        chunksCompressed: result.chunksCompressed,
        totalChunks: result.totalChunks,
        ...(result.sampledChunks !== undefined ? { sampledChunks: result.sampledChunks } : {}),
        facts: result.facts,
      });
      compressed[raw.relPath] = { bytes: info.size, lastObservationAt: observedAt, compressVersion: CURRENT_COMPRESS_VERSION };
      files.push({
        path: raw.relPath,
        outcome: "compressed",
        facts: result.facts.length,
        factPath,
        inputTokens: result.inputTokens,
        chunksCompressed: result.chunksCompressed,
        totalChunks: result.totalChunks,
        ...(result.sampledChunks !== undefined ? { sampledChunks: result.sampledChunks } : {}),
      });
      tokensUsed = addTokenUsage(tokensUsed, result.tokensUsed);
    } catch (err) {
      files.push({ path: raw.relPath, outcome: "failed", facts: 0, reason: errorMessage(err) });
    }
  }

  if (mode === "apply") {
    await writeCompileStateFile(root, { ...state, compressed });
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

async function listRawFiles(root: string, rawRoot: string): Promise<Array<{ fullPath: string; relPath: string }>> {
  if (!existsSync(rawRoot)) return [];
  const files: Array<{ fullPath: string; relPath: string }> = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push({ fullPath, relPath: relative(root, fullPath).replace(/\\/g, "/") });
      }
    }
  }
  await walk(rawRoot);
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
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
