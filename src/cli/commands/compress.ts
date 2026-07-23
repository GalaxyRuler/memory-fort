import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { mutateCompileStateFile, readCompressedMap, readCompileStateFile, writeCompileStateFile, type CompileConsumedWatermark } from "../../compile/state.js";
import { createLLMFromConfig, getActiveLLMConfig, type LLMConfig } from "../../llm/factory.js";
import { estimateLLMCostUsd } from "../../llm/pricing.js";
import type { LLMProvider, LLMTokenUsage } from "../../llm/types.js";
import { redactSecrets } from "../../privacy/redaction.js";
import { loadMemoryConfig, resolveCompileConfig, type MemoryConfig } from "../../storage/config.js";
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
const MAX_COMPRESS_ATTEMPTS = 3;

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

interface CompressQuarantineEntry {
  attempts: number;
  bytes: number;
  mtimeMs?: number;
}

function readCompressQuarantine(state: Record<string, unknown>): Record<string, CompressQuarantineEntry> {
  const value = state["compressQuarantine"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, CompressQuarantineEntry> = {};
  for (const [path, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec["attempts"] === "number" && typeof rec["bytes"] === "number") {
      out[path] = {
        attempts: rec["attempts"],
        bytes: rec["bytes"],
        ...(typeof rec["mtimeMs"] === "number" ? { mtimeMs: rec["mtimeMs"] } : {}),
      };
    }
  }
  return out;
}

export async function runCompress(opts: CompressOptions = {}): Promise<CompressResult> {
  const root = opts.vaultRoot ?? memoryRoot();
  const mode = opts.apply ? "apply" : "plan";
  const rawFiles = await listRawMarkdownFiles(root);
  const state = await readCompileStateFile(root);
  const compressed = readCompressedMap(state);
  // A separate quarantine tally (NOT the coverage watermark, so it can never
  // affect completeness): a file whose compression keeps failing is retried a
  // bounded number of times, then skipped so the drain and later files proceed.
  // Its raw is left uncovered, so compile handles it normally — no content lost.
  const quarantine = readCompressQuarantine(state);
  // One-time enrichment of legacy size-only watermarks with mtime+hash (no LLM
  // cost) so future passes are cheap and same-size edits become detectable.
  const watermarkUpgrades: Record<string, CompileConsumedWatermark> = {};
  const maxSessions = positiveInteger(opts.maxSessions, DEFAULT_MAX_SESSIONS);
  const files: CompressResult["files"] = [];
  let tokensUsed: LLMTokenUsage | undefined;

  let llm: LLMProvider | undefined;
  let compressConfig = defaultCompressConfig();
  let faithfulnessCheck = true;
  if (mode === "apply") {
    const env = opts.env ?? process.env;
    const config = await (opts.configLoader ?? (() => loadMemoryConfig(root)))();
    compressConfig = compressConfigFromMemoryConfig(config);
    faithfulnessCheck = resolveCompileConfig(config.compile).faithfulness_check;
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
    const cursorComplete = watermark !== undefined
      && (watermark.chunkTotal === undefined || (watermark.chunkCursor ?? 0) >= watermark.chunkTotal);
    if (versionMatches && bytesMatch && cursorComplete) {
      // Same version+size+cursor. Confirm CONTENT identity before skipping —
      // size alone misses a same-length in-place edit (conservation hole).
      if (watermark!.mtimeMs === info.mtimeMs) {
        files.push({ path: raw.relPath, outcome: "skipped", facts: 0, reason: "already compressed" });
        continue;
      }
      // mtime differs (edit, OR a git checkout that only bumps mtime) or the
      // watermark predates hashing: read + hash to disambiguate.
      const currentHash = sha256(await readFile(raw.fullPath, "utf-8"));
      if (watermark!.sourceHash === undefined || watermark!.sourceHash === currentHash) {
        // Unchanged content (or a legacy watermark we won't pay to recompile):
        // enrich with mtime+hash so the next pass is cheap and a future
        // same-size edit is caught, then treat as complete.
        watermarkUpgrades[raw.relPath] = { ...watermark!, mtimeMs: info.mtimeMs, sourceHash: currentHash };
        files.push({ path: raw.relPath, outcome: "skipped", facts: 0, reason: "already compressed" });
        continue;
      }
      // sourceHash present AND differs → genuine same-size content change → reprocess.
    }
    const quarantined = quarantine[raw.relPath];
    if (quarantined && quarantined.attempts >= MAX_COMPRESS_ATTEMPTS
      && quarantined.bytes === info.size && quarantined.mtimeMs === info.mtimeMs) {
      files.push({
        path: raw.relPath,
        outcome: "skipped",
        facts: 0,
        reason: `quarantined after ${quarantined.attempts} failed compress attempts — left for compile`,
      });
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
    let rawSourceHash: string | undefined;
    try {
      const rawText = await readFile(raw.fullPath, "utf-8");
      const currentHash = sha256(rawText);
      rawSourceHash = currentHash;
      // Content identity, not size: a same-length in-place edit has bytesMatch
      // true but changed content. Legacy watermarks without a sourceHash fall
      // back to size (append-only assumption).
      const sourceUnchanged = watermark?.sourceHash !== undefined
        ? watermark.sourceHash === currentHash
        : bytesMatch;
      const sessionId = readSessionId(rawText) ?? basename(raw.relPath, ".md");
      const observedAt = observedAtFromRaw(raw.relPath, info.mtimeMs);
      const factRelPath = factFileRelPath(raw.relPath, sessionId);

      // Resume only when the content is unchanged AND the chunking fingerprint
      // matches — chunk boundaries derive from maxBytesPerCall, so a config
      // change makes a stored cursor point into a different chunking, and a
      // content edit invalidates the cursor entirely.
      let startChunk = versionMatches && bytesMatch && sourceUnchanged
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
        faithfulnessCheck,
        startChunk,
      });

      // Decide whether to preserve prior facts by MERGING, or discard them by
      // overwriting. Preserve when:
      //   - their watermark is already at the current safety-contract version,
      //   - the bytes are unchanged (a resume, or a config-only re-chunk), OR
      //   - an archive copy exists whose content hash equals the PRIOR
      //     watermark's sourceHash — i.e. this change is a compaction of exactly
      //     the content the prior facts were extracted from, now living only in
      //     the (walker-excluded) archive.
      // Earlier versions predate the v4 evidence/faithfulness gate, so even a
      // same-content artifact is not trusted or carried forward.
      // Binding to the prior source hash (not mere archive existence) is what
      // stops a later unrelated edit from preserving stale facts forever: after
      // a compaction the watermark's sourceHash advances to the compacted
      // content, so a subsequent edit's prior hash matches no archive copy.
      const preservePrior = versionMatches && priorValid && priorFacts.length > 0
        && ((bytesMatch && sourceUnchanged) || await archiveHasSourceHash(root, raw.relPath, watermark?.sourceHash));
      const mergedFacts = preservePrior
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
        mtimeMs: info.mtimeMs,
        sourceHash: sha256(rawText),
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
      delete quarantine[raw.relPath]; // a successful pass clears the fail tally
    } catch (err) {
      const reason = redactSecrets(errorMessage(err));
      await writeCompressionRejectionReview({
        vaultRoot: root,
        rawRelPath: raw.relPath,
        sourceHash: rawSourceHash,
        bytes: info.size,
        reason,
        now: opts.now ?? new Date(),
      });
      const prior = quarantine[raw.relPath];
      // Reset the tally when the source changed (size OR mtime) — a corrected
      // file is a new source version and deserves fresh attempts.
      const sameSource = prior && prior.bytes === info.size && prior.mtimeMs === info.mtimeMs;
      const attempts = sameSource ? prior!.attempts + 1 : 1;
      quarantine[raw.relPath] = { attempts, bytes: info.size, mtimeMs: info.mtimeMs };
      files.push({ path: raw.relPath, outcome: "failed", facts: 0, reason });
    }
  }

  if (mode === "apply") {
    // Apply legacy-watermark enrichments (no LLM cost) for files skipped as
    // already-complete this pass.
    for (const [path, wm] of Object.entries(watermarkUpgrades)) {
      if (compressed[path] !== undefined) compressed[path] = wm;
    }
    await mutateCompileStateFile(root, (fresh) => ({
      ...fresh,
      compressed,
      ...(Object.keys(quarantine).length > 0 ? { compressQuarantine: quarantine } : { compressQuarantine: undefined }),
    }));
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


/**
 * True when compact-raw archived a copy of this raw file whose content hash
 * equals `targetHash` (the prior watermark's sourceHash — the content the prior
 * facts were extracted from). This proves the current byte change is a
 * compaction of exactly that source version, so the prior facts should be
 * preserved. Existence alone is NOT enough: after a compaction the watermark's
 * sourceHash advances, so a later unrelated edit's prior hash matches no archive
 * copy and its stale facts are correctly discarded. compact-raw archives to
 * raw/.compact-archive/<date>/<original-relPath> (leading "raw/" stripped).
 */
async function archiveHasSourceHash(root: string, rawRelPath: string, targetHash: string | undefined): Promise<boolean> {
  if (!targetHash) return false;
  const archiveRoot = join(root, "raw", ".compact-archive");
  if (!existsSync(archiveRoot)) return false;
  let dates: string[];
  try {
    dates = await readdir(archiveRoot);
  } catch {
    return false;
  }
  const relParts = rawRelPath.replace(/^raw\//, "").split("/");
  for (const date of dates) {
    const candidate = join(archiveRoot, date, ...relParts);
    if (!existsSync(candidate)) continue;
    try {
      if (sha256(await readFile(candidate, "utf-8")) === targetHash) return true;
    } catch {
      // unreadable archive copy — ignore
    }
  }
  return false;
}

async function writeCompressionRejectionReview(opts: {
  vaultRoot: string;
  rawRelPath: string;
  sourceHash?: string;
  bytes: number;
  reason: string;
  now: Date;
}): Promise<void> {
  // Keep the precise raw reference and content fingerprint reviewable without
  // duplicating raw text or an untrusted LLM candidate into a wiki artifact.
  // Raw sessions can contain sensitive material; the canonical source remains
  // the redacted-at-prompt raw file named below.
  const fingerprint = sha256(opts.rawRelPath).slice(0, 16);
  const reviewDir = join(opts.vaultRoot, "wiki", ".audit", "compress-rejections");
  const reviewPath = join(reviewDir, `${fingerprint}.md`);
  await mkdir(reviewDir, { recursive: true });
  await writeFile(reviewPath, [
    "# Compression rejection review",
    "",
    `Recorded: ${opts.now.toISOString()}`,
    `Raw source: ${opts.rawRelPath}`,
    `Source hash: ${opts.sourceHash ?? "unavailable (source read failed)"}`,
    `Source bytes: ${opts.bytes}`,
    "",
    "Evidence context:",
    "- Inspect the retained raw source at the path above; its text is deliberately not copied here because it may contain secrets.",
    "- The source hash binds this review to the exact raw version that was rejected.",
    "",
    "Rejection reason:",
    opts.reason,
    "",
  ].join("\n"), "utf-8");
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
