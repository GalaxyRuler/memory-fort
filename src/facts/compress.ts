import { Buffer } from "node:buffer";
import { chatWithAudit } from "../llm/audit.js";
import type { LLMProvider, LLMRequest, LLMTokenUsage } from "../llm/types.js";
import { redactSecrets } from "../privacy/redaction.js";
import {
  COMPRESSED_FACT_TYPES,
  readCompressedFactType,
  type CompressedFact,
  type CompressedFactRelation,
} from "./store.js";

export interface CompressSessionOptions {
  rawText: string;
  rawRelPath: string;
  sessionId: string;
  observedAt: string;
  llm: LLMProvider;
  maxInputBytes?: number;
  chunkThresholdBytes?: number;
  maxChunks?: number;
  maxCallTokens?: number;
  vaultRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  logger?: (line: string) => void;
  /** Resume compression from this chunk index (contiguous window). Default 0. */
  startChunk?: number;
}

export interface CompressSessionResult {
  facts: CompressedFact[];
  tokensUsed?: LLMTokenUsage;
  inputBytes: number;
  inputTokens: number;
  chunksCompressed: number;
  totalChunks: number;
  sampledChunks?: number;
  /** Next chunk index to process next pass (== totalChunks when fully covered). */
  chunkCursor: number;
  /** The maxBytesPerCall this run chunked with — the resume fingerprint. */
  chunkBytes: number;
}

// v3: contiguous resumable windows replaced the fixed 8-chunk sample. Bumped so
// lossy v2 watermarks (which marked files "complete" after sampling) are treated
// as stale and re-covered under the new algorithm.
export const CURRENT_COMPRESS_VERSION = 3;
export const DEFAULT_COMPRESS_MAX_INPUT_BYTES = 48_000;
export const DEFAULT_COMPRESS_CHUNK_THRESHOLD_BYTES = 48_000;
export const DEFAULT_COMPRESS_MAX_CHUNKS = 8;
export const DEFAULT_COMPRESS_MAX_CALL_TOKENS = 100_000;

interface RuntimeCompressConfig {
  maxInputBytes: number;
  chunkThresholdBytes: number;
  maxChunks: number;
  maxCallTokens: number;
  maxBytesPerCall: number;
}

interface SessionChunk {
  text: string;
  originalIndex: number;
}

export async function compressSession(opts: CompressSessionOptions): Promise<CompressedFact[]> {
  return (await compressSessionWithUsage(opts)).facts;
}

export async function compressSessionWithUsage(opts: CompressSessionOptions): Promise<CompressSessionResult> {
  const config = resolveCompressConfig(opts);
  const allChunks = splitSessionIntoChunks(opts.rawText, config.maxBytesPerCall);
  // Contiguous window [startChunk, startChunk + maxChunks). Each pass processes
  // the next window and reports the cursor; the caller resumes from it. This
  // replaces a fixed spread-sample that permanently excluded unsampled chunks.
  const startChunk = Math.max(0, Math.min(opts.startChunk ?? 0, allChunks.length));
  const endChunk = Math.min(allChunks.length, startChunk + config.maxChunks);
  const selectedChunkIndexes = Array.from(
    { length: endChunk - startChunk },
    (_, offset) => startChunk + offset,
  );
  const sampledChunks = selectedChunkIndexes.length < allChunks.length ? selectedChunkIndexes.length : undefined;
  if (endChunk < allChunks.length || startChunk > 0) {
    (opts.logger ?? console.warn)(
      `memory compress: processing chunks ${startChunk + 1}-${endChunk} of ${allChunks.length} for ${opts.rawRelPath}; remainder resumes next pass`,
    );
  }

  const compressedAt = (opts.now ?? new Date()).toISOString();
  const partialFacts: CompressedFact[] = [];
  let tokensUsed: LLMTokenUsage | undefined;
  let inputTokens = 0;

  for (const chunkIndex of selectedChunkIndexes) {
    const chunk = allChunks[chunkIndex]!;
    const redactedChunk = redactSecrets(chunk.text);
    inputTokens += estimateTokens(redactedChunk);
    const request = buildCompressionRequest({
      rawRelPath: opts.rawRelPath,
      sessionId: opts.sessionId,
      chunkText: redactedChunk,
      chunkNumber: chunk.originalIndex + 1,
      totalChunks: allChunks.length,
    });
    const response = opts.vaultRoot
      ? await chatWithAudit({
          llm: opts.llm,
          vaultRoot: opts.vaultRoot,
          consumer: "session-compress",
          request,
          env: opts.env,
        })
      : await opts.llm.chat(request);
    if (response.finishReason !== "stop") {
      const reason = response.finishReason === "length" || response.finishReason === "filter"
        ? "response truncated"
        : "response unverifiable";
      throw new Error(
        `memory compress: ${reason} (finishReason=${response.finishReason}) for ${opts.rawRelPath} chunk ${chunk.originalIndex + 1}/${allChunks.length}; nothing persisted for this file`,
      );
    }
    // Malformed output is a provider failure, not a valid "zero facts" result —
    // recording it as complete coverage would suppress this raw from compile
    // with nothing extracted. Two malformed shapes are rejected: (a) no parseable
    // facts array at all; (b) a non-empty facts array whose members do not
    // survive normalization ({"facts":[{}]}, or a mix that silently drops some).
    // A genuinely empty array ({"facts":[]}) is a valid "no facts here" result.
    const rawArray = extractFactsArray(response.content);
    if (rawArray === null) {
      throw new Error(
        `memory compress: response was not valid facts JSON for ${opts.rawRelPath} chunk ${chunk.originalIndex + 1}/${allChunks.length}; nothing persisted for this file`,
      );
    }
    const chunkFacts = parseCompressedFacts({
      content: response.content,
      rawRelPath: opts.rawRelPath,
      sessionId: opts.sessionId,
      observedAt: opts.observedAt,
      compressedAt,
      ...(sampledChunks !== undefined ? { sampledChunks, totalChunks: allChunks.length } : {}),
    });
    if (rawArray.length > 0 && chunkFacts.length < rawArray.length) {
      throw new Error(
        `memory compress: ${rawArray.length - chunkFacts.length} of ${rawArray.length} fact record(s) were unusable for ${opts.rawRelPath} chunk ${chunk.originalIndex + 1}/${allChunks.length}; nothing persisted for this file`,
      );
    }
    partialFacts.push(...chunkFacts);
    tokensUsed = addTokenUsage(tokensUsed, response.tokensUsed);
  }

  const facts = mergeCompressedFacts(partialFacts);
  return {
    facts,
    inputBytes: Buffer.byteLength(opts.rawText, "utf-8"),
    inputTokens,
    chunksCompressed: selectedChunkIndexes.length,
    totalChunks: allChunks.length,
    chunkCursor: endChunk,
    chunkBytes: config.maxBytesPerCall,
    ...(sampledChunks !== undefined ? { sampledChunks } : {}),
    ...(tokensUsed ? { tokensUsed } : {}),
  };
}

/**
 * Extract the raw facts array from LLM output, or null when the output is
 * MALFORMED (no JSON, unparseable JSON, or no facts array). Callers must treat
 * null differently from a valid empty `{"facts":[]}` — writing "zero facts,
 * fully covered" for garbage output silently suppresses the raw from compile.
 */
export function extractFactsArray(content: string): unknown[] | null {
  const json = extractJsonObject(content);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { facts?: unknown }).facts)) {
    return null;
  }
  return (parsed as { facts: unknown[] }).facts;
}

export function parseCompressedFacts(opts: {
  content: string;
  rawRelPath: string;
  sessionId: string;
  observedAt: string;
  compressedAt: string;
  sampledChunks?: number;
  totalChunks?: number;
}): CompressedFact[] {
  const values = extractFactsArray(opts.content) ?? [];
  return values.map((value) => normalizeFact(value, opts)).filter((fact): fact is CompressedFact => fact !== null);
}

export function addTokenUsage(left: LLMTokenUsage | undefined, right: LLMTokenUsage | undefined): LLMTokenUsage | undefined {
  if (!right) return left;
  return {
    prompt: (left?.prompt ?? 0) + right.prompt,
    completion: (left?.completion ?? 0) + right.completion,
    total: (left?.total ?? 0) + right.total,
  };
}

function normalizeFact(value: unknown, opts: {
  rawRelPath: string;
  sessionId: string;
  observedAt: string;
  compressedAt: string;
  sampledChunks?: number;
  totalChunks?: number;
}): CompressedFact | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = readString(record.title);
  const facts = readStringArray(record.facts);
  const narrative = readString(record.narrative);
  const concepts = readStringArray(record.concepts);
  const files = readStringArray(record.files);
  const importance = readImportance(record.importance);
  if (!title || facts.length === 0 || !narrative || concepts.length === 0 || importance === null) return null;
  return {
    title,
    facts,
    narrative,
    concepts,
    files,
    importance,
    ...readOptionalFactType(record.type),
    ...readOptionalStringArray(record.entities, "entities"),
    ...readOptionalRelationTriples(record.relations),
    sessionId: opts.sessionId,
    sourceRawPath: opts.rawRelPath.replace(/\\/g, "/"),
    observedAt: opts.observedAt,
    compressedAt: opts.compressedAt,
    ...(opts.sampledChunks !== undefined ? { sampledChunks: opts.sampledChunks } : {}),
    ...(opts.totalChunks !== undefined ? { totalChunks: opts.totalChunks } : {}),
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readOptionalStringArray(value: unknown, key: "entities"): Record<string, string[]> {
  const values = readStringArray(value);
  return values.length > 0 ? { [key]: values } : {};
}

function readOptionalRelationTriples(value: unknown): { relations: CompressedFactRelation[] } | Record<string, never> {
  if (!Array.isArray(value)) return {};
  const relations = value
    .map(readRelationTriple)
    .filter((relation): relation is CompressedFactRelation => relation !== null);
  return relations.length > 0 ? { relations } : {};
}

function readRelationTriple(value: unknown): CompressedFactRelation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const subject = readString(record.subject);
  const predicate = readString(record.predicate);
  const object = readString(record.object);
  return subject && predicate && object ? { subject, predicate, object } : null;
}

function readImportance(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(1, Math.min(10, Math.round(value)));
}

function extractJsonObject(content: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/m.exec(content)?.[1]?.trim();
  if (fenced) return fenced;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}

function buildCompressionRequest(opts: {
  rawRelPath: string;
  sessionId: string;
  chunkText: string;
  chunkNumber: number;
  totalChunks: number;
}): LLMRequest {
  const chunkLabel = opts.totalChunks > 1
    ? `Chunk ${opts.chunkNumber} of ${opts.totalChunks}`
    : "Whole session";
  return {
    messages: [
      {
        role: "system",
        content: [
          "You compress memory observations into durable structured facts.",
          "Return only JSON shaped like: {\"facts\":[{\"title\":string,\"type\":string,\"facts\":string[],\"narrative\":string,\"concepts\":string[],\"files\":string[],\"importance\":number,\"entities\":string[],\"relations\":[{\"subject\":string,\"predicate\":string,\"object\":string}]}]}",
          `Type enum: ${COMPRESSED_FACT_TYPES.join(", ")}. Use procedure for durable workflows, decision for choices, lesson for reusable learnings, project for project/entity state, reference for durable docs, tool for tools, people for people, fact for uncategorized facts.`,
          "Also extract named entities and relation triples already evidenced in the session; use concise predicates such as mentions, uses, derived_from, depends_on, tested-with.",
          "Importance scale: 1-3 routine reads, 4-6 edits/commands, 7-9 architectural decisions, 10 breaking changes.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "Extract the salient facts from this session text.",
          "Create one fact bundle per distinct durable topic/entity.",
          "Ignore transient prompts, tool chatter, duplicated logs, and unrelated content.",
          "Do not invent facts. Strip secrets.",
          "",
          `Source raw path: ${opts.rawRelPath}`,
          `Session id: ${opts.sessionId}`,
          chunkLabel,
          "",
          "Session text:",
          "```markdown",
          opts.chunkText,
          "```",
        ].join("\n"),
      },
    ],
    temperature: 0.1,
  };
}

/**
 * The chunk-boundary fingerprint: chunk boundaries depend only on these three
 * inputs, so the compress command stores this value and restarts a partial file
 * from chunk 0 when it changes (a stale cursor would otherwise point into a
 * different chunking). Shared here so the command computes it identically.
 */
export function resolveMaxBytesPerCall(config: {
  maxInputBytes: number;
  chunkThresholdBytes: number;
  maxCallTokens: number;
}): number {
  const tokenSafeBytes = Math.max(1, config.maxCallTokens * 4);
  return Math.max(1, Math.min(config.maxInputBytes, config.chunkThresholdBytes, tokenSafeBytes));
}

function resolveCompressConfig(opts: CompressSessionOptions): RuntimeCompressConfig {
  const maxInputBytes = positiveInteger(opts.maxInputBytes, DEFAULT_COMPRESS_MAX_INPUT_BYTES);
  const chunkThresholdBytes = positiveInteger(opts.chunkThresholdBytes, DEFAULT_COMPRESS_CHUNK_THRESHOLD_BYTES);
  const maxChunks = positiveInteger(opts.maxChunks, DEFAULT_COMPRESS_MAX_CHUNKS, 2);
  const maxCallTokens = positiveInteger(opts.maxCallTokens, DEFAULT_COMPRESS_MAX_CALL_TOKENS);
  return {
    maxInputBytes,
    chunkThresholdBytes,
    maxChunks,
    maxCallTokens,
    maxBytesPerCall: resolveMaxBytesPerCall({ maxInputBytes, chunkThresholdBytes, maxCallTokens }),
  };
}

function splitSessionIntoChunks(text: string, maxBytes: number): SessionChunk[] {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return [{ text, originalIndex: 0 }];
  const blocks = splitObservationBlocks(text);
  const chunks: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (Buffer.byteLength(block, "utf-8") > maxBytes) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitOversizedBlock(block, maxBytes));
      continue;
    }
    const next = current ? `${current}\n${block}` : block;
    if (current && Buffer.byteLength(next, "utf-8") > maxBytes) {
      chunks.push(current);
      current = block;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((chunk, originalIndex) => ({ text: chunk, originalIndex }));
}

function splitObservationBlocks(text: string): string[] {
  const matches = [...text.matchAll(/^## \[[^\]\n]+\].*$/gm)];
  if (matches.length === 0) return [text];
  const blocks: string[] = [];
  if ((matches[0]?.index ?? 0) > 0) {
    blocks.push(text.slice(0, matches[0]!.index).trimEnd());
  }
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index]!.index!;
    const end = matches[index + 1]?.index ?? text.length;
    const block = text.slice(start, end).trimEnd();
    if (block) blocks.push(block);
  }
  return blocks.filter((block) => block.trim().length > 0);
}

function splitOversizedBlock(block: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const lines = block.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = `${lines[index]}${index < lines.length - 1 ? "\n" : ""}`;
    if (Buffer.byteLength(line, "utf-8") > maxBytes) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitByUtf8Bytes(line, maxBytes));
      continue;
    }
    const next = `${current}${line}`;
    if (current && Buffer.byteLength(next, "utf-8") > maxBytes) {
      chunks.push(current.trimEnd());
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current.trimEnd());
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

function splitByUtf8Bytes(text: string, maxBytes: number): string[] {
  const buffer = Buffer.from(text, "utf-8");
  const chunks: string[] = [];
  let start = 0;
  while (start < buffer.byteLength) {
    let end = Math.min(start + maxBytes, buffer.byteLength);
    while (end > start && end < buffer.byteLength && (buffer[end] & 0b1100_0000) === 0b1000_0000) {
      end -= 1;
    }
    if (end === start) end = Math.min(start + maxBytes, buffer.byteLength);
    chunks.push(buffer.subarray(start, end).toString("utf-8"));
    start = end;
  }
  return chunks;
}


/** Omitted type and the literal "fact" are the same generic identity. */
function normalizedFactType(type: string | undefined): string {
  return type && type !== "fact" ? type : "fact";
}

export function mergeCompressedFacts(facts: CompressedFact[]): CompressedFact[] {
  const merged: CompressedFact[] = [];
  for (const fact of facts) {
    // Identity is a similar title AND the same NORMALIZED type. A near-identical
    // title across different substantive types (a `decision` vs a `lesson`) is a
    // DISTINCT fact — merging on title alone collapsed them and dropped the
    // newer type. But the generic type is written two equivalent ways (omitted
    // vs the literal "fact"), so those must normalize to one identity or the
    // same generic fact double-counts across passes.
    const existing = merged.find((candidate) =>
      normalizedFactType(candidate.type) === normalizedFactType(fact.type)
      && titleSimilarity(candidate.title, fact.title) >= 0.82);
    if (!existing) {
      merged.push({ ...fact });
      continue;
    }
    existing.facts = uniqueStrings([...existing.facts, ...fact.facts]);
    existing.concepts = uniqueStrings([...existing.concepts, ...fact.concepts]);
    existing.files = uniqueStrings([...existing.files, ...fact.files]);
    existing.entities = mergeOptionalStrings(existing.entities, fact.entities);
    existing.relations = mergeOptionalRelations(existing.relations, fact.relations);
    existing.importance = Math.max(existing.importance, fact.importance);
    if (!existing.type || existing.type === "fact") {
      if (fact.type) existing.type = fact.type;
    }
    if (!textContains(existing.narrative, fact.narrative)) {
      existing.narrative = `${existing.narrative}\n${fact.narrative}`;
    }
    if (fact.sampledChunks !== undefined) existing.sampledChunks = fact.sampledChunks;
    if (fact.totalChunks !== undefined) existing.totalChunks = fact.totalChunks;
  }
  return merged;
}

function titleSimilarity(left: string, right: string): number {
  const leftTokens = new Set(titleTokens(left));
  const rightTokens = new Set(titleTokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function titleTokens(value: string): string[] {
  // Unicode letters/numbers, not just ASCII — an ASCII-only class tokenizes a
  // non-Latin title (Arabic, CJK, Cyrillic) to the empty set, so two identical
  // such titles never match and duplicate on every merge.
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mergeOptionalStrings(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
  const merged = uniqueStrings([...(left ?? []), ...(right ?? [])]);
  return merged.length > 0 ? merged : undefined;
}

function mergeOptionalRelations(
  left: CompressedFactRelation[] | undefined,
  right: CompressedFactRelation[] | undefined,
): CompressedFactRelation[] | undefined {
  const byKey = new Map<string, CompressedFactRelation>();
  for (const relation of [...(left ?? []), ...(right ?? [])]) {
    const key = [
      relation.subject.trim().toLowerCase(),
      relation.predicate.trim().toLowerCase(),
      relation.object.trim().toLowerCase(),
    ].join("\0");
    if (!byKey.has(key)) byKey.set(key, relation);
  }
  const merged = [...byKey.values()];
  return merged.length > 0 ? merged : undefined;
}

function textContains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

function readOptionalFactType(value: unknown): { type: CompressedFact["type"] } | Record<string, never> {
  const type = readCompressedFactType(value);
  return type ? { type } : {};
}

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf-8") / 4);
}

function positiveInteger(value: number | undefined, fallback: number, min = 1): number {
  return value !== undefined && Number.isInteger(value) && value >= min ? value : fallback;
}
