import { chatWithAudit } from "../llm/audit.js";
import type { LLMProvider, LLMTokenUsage } from "../llm/types.js";
import type { CompileStateFile } from "./state.js";

export interface ExtractEntityFactsOptions {
  rawText: string;
  entity: string;
  entityContext?: string;
  llm: LLMProvider;
  maxBytes?: number;
  vaultRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExtractEntityFactsResult {
  facts: string[];
  tokensUsed?: LLMTokenUsage;
  truncated: boolean;
}

export interface CachedExtractEntityFactsOptions extends ExtractEntityFactsOptions {
  state: CompileStateFile;
  rawRelPath: string;
  startByte: number;
  endByte: number;
  now?: Date;
}

export interface CachedExtractEntityFactsResult extends ExtractEntityFactsResult {
  fromCache: boolean;
}

interface FactExtractionCacheEntry {
  facts: string[];
  extractedAt?: string;
  tokensUsed?: LLMTokenUsage;
}

const DEFAULT_EXTRACT_MAX_BYTES = 20_000;

export async function extractEntityFacts(opts: ExtractEntityFactsOptions): Promise<ExtractEntityFactsResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_EXTRACT_MAX_BYTES;
  const chunks = chunkUtf8(opts.rawText, maxBytes);
  const facts: string[] = [];
  let tokensUsed: LLMTokenUsage | undefined;
  let truncated = false;

  for (const chunk of chunks) {
    const response = opts.vaultRoot
      ? await chatWithAudit({
        llm: opts.llm,
        vaultRoot: opts.vaultRoot,
        consumer: "entity-fact-extract",
        request: factExtractionRequest({
          rawText: chunk,
          entity: opts.entity,
          entityContext: opts.entityContext,
        }),
        env: opts.env,
      })
      : await opts.llm.chat(factExtractionRequest({
        rawText: chunk,
        entity: opts.entity,
        entityContext: opts.entityContext,
      }));
    tokensUsed = addTokenUsage(tokensUsed, response.tokensUsed);
    if (response.finishReason === "length" || response.finishReason === "filter") {
      truncated = true;
      break;
    }
    facts.push(...parseFactsResponse(response.content));
  }

  return {
    facts: dedupeFacts(facts),
    truncated,
    ...(tokensUsed ? { tokensUsed } : {}),
  };
}

export async function extractEntityFactsCached(
  opts: CachedExtractEntityFactsOptions,
): Promise<CachedExtractEntityFactsResult> {
  const key = factExtractionCacheKey({
    rawRelPath: opts.rawRelPath,
    startByte: opts.startByte,
    endByte: opts.endByte,
    entity: opts.entity,
  });
  const cache = readFactExtractionCache(opts.state);
  const cached = cache[key];
  if (cached) {
    return {
      facts: [...cached.facts],
      truncated: false,
      ...(cached.tokensUsed ? { tokensUsed: cached.tokensUsed } : {}),
      fromCache: true,
    };
  }

  const extracted = await extractEntityFacts(opts);
  if (!extracted.truncated) {
    cache[key] = {
      facts: extracted.facts,
      extractedAt: (opts.now ?? new Date()).toISOString(),
      ...(extracted.tokensUsed ? { tokensUsed: extracted.tokensUsed } : {}),
    };
    opts.state.factExtraction = cache;
  }
  return { ...extracted, fromCache: false };
}

export function factExtractionCacheKey(opts: {
  rawRelPath: string;
  startByte: number;
  endByte: number;
  entity: string;
}): string {
  return [
    opts.rawRelPath.replace(/\\/g, "/"),
    `${Math.max(0, Math.floor(opts.startByte))}-${Math.max(0, Math.floor(opts.endByte))}`,
    normalizeEntity(opts.entity),
  ].join("|");
}

export function addTokenUsage(
  left: LLMTokenUsage | undefined,
  right: LLMTokenUsage | undefined,
): LLMTokenUsage | undefined {
  if (!right) return left;
  return {
    prompt: (left?.prompt ?? 0) + right.prompt,
    completion: (left?.completion ?? 0) + right.completion,
    total: (left?.total ?? 0) + right.total,
  };
}

function factExtractionRequest(opts: {
  rawText: string;
  entity: string;
  entityContext?: string;
}) {
  return {
    messages: [
      {
        role: "system" as const,
        content: "You are an entity fact extractor. Return only JSON: {\"facts\": string[]}.",
      },
      {
        role: "user" as const,
        content: [
          `From this raw agent-session text, extract only concrete, durable facts about ${opts.entity} (decisions made, features shipped, status changes, design choices).`,
          "Ignore prompts, tool output, and anything not a fact about the entity.",
          "If there are none, return an empty list. Do not invent.",
          opts.entityContext ? `Entity context: ${opts.entityContext}` : "",
          "",
          "Raw session text:",
          "```markdown",
          opts.rawText.trim(),
          "```",
        ].filter((line) => line !== "").join("\n"),
      },
    ],
    temperature: 0,
  };
}

function parseFactsResponse(content: string): string[] {
  const json = extractJsonObject(content.trim());
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const facts = (parsed as Record<string, unknown>)["facts"];
  if (!Array.isArray(facts)) return [];
  return facts
    .filter((fact): fact is string => typeof fact === "string")
    .map((fact) => fact.trim())
    .filter((fact) => fact.length > 0);
}

function extractJsonObject(content: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/m.exec(content)?.[1]?.trim();
  if (fenced) return fenced;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}

function chunkUtf8(text: string, maxBytes: number): string[] {
  const cap = Math.max(1, maxBytes);
  if (Buffer.byteLength(text, "utf-8") <= cap) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    const next = current.length === 0 ? line : `${current}\n${line}`;
    if (Buffer.byteLength(next, "utf-8") > cap && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim().length > 0) chunks.push(current);
  return chunks;
}

function dedupeFacts(facts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const fact of facts) {
    const key = fact.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}

function readFactExtractionCache(state: CompileStateFile): Record<string, FactExtractionCacheEntry> {
  const existing = state.factExtraction;
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) return {};
  const parsed: Record<string, FactExtractionCacheEntry> = {};
  for (const [key, value] of Object.entries(existing as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const facts = record["facts"];
    if (!Array.isArray(facts)) continue;
    parsed[key] = {
      facts: facts.filter((fact): fact is string => typeof fact === "string"),
      ...(typeof record["extractedAt"] === "string" ? { extractedAt: record["extractedAt"] } : {}),
      ...(isTokenUsage(record["tokensUsed"]) ? { tokensUsed: record["tokensUsed"] } : {}),
    };
  }
  return parsed;
}

function isTokenUsage(value: unknown): value is LLMTokenUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record["prompt"] === "number"
    && typeof record["completion"] === "number"
    && typeof record["total"] === "number";
}

function normalizeEntity(entity: string): string {
  return entity.toLowerCase().replace(/\s+/g, " ").trim();
}
