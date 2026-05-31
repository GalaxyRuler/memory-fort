import { Buffer } from "node:buffer";
import { chatWithAudit } from "../llm/audit.js";
import type { LLMProvider, LLMTokenUsage } from "../llm/types.js";
import type { CompressedFact } from "./store.js";

export interface CompressSessionOptions {
  rawText: string;
  rawRelPath: string;
  sessionId: string;
  observedAt: string;
  llm: LLMProvider;
  maxInputBytes?: number;
  vaultRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface CompressSessionResult {
  facts: CompressedFact[];
  tokensUsed?: LLMTokenUsage;
}

const DEFAULT_MAX_INPUT_BYTES = 4_000;

export async function compressSession(opts: CompressSessionOptions): Promise<CompressedFact[]> {
  return (await compressSessionWithUsage(opts)).facts;
}

export async function compressSessionWithUsage(opts: CompressSessionOptions): Promise<CompressSessionResult> {
  const request = {
    messages: [
      {
        role: "system" as const,
        content: [
          "You compress memory observations into durable structured facts.",
          "Return only JSON: {\"facts\":[{\"title\":string,\"facts\":string[],\"narrative\":string,\"concepts\":string[],\"files\":string[],\"importance\":number}]}",
          "Importance scale: 1-3 routine reads, 4-6 edits/commands, 7-9 architectural decisions, 10 breaking changes.",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: [
          "Extract the salient facts from this whole session.",
          "Create one fact bundle per distinct durable topic/entity.",
          "Ignore transient prompts, tool chatter, duplicated logs, and unrelated content.",
          "Do not invent facts. Strip secrets.",
          "",
          `Source raw path: ${opts.rawRelPath}`,
          `Session id: ${opts.sessionId}`,
          "",
          "Session text:",
          "```markdown",
          truncateUtf8(redactSecrets(opts.rawText), opts.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES),
          "```",
        ].join("\n"),
      },
    ],
    temperature: 0.1,
  };
  const response = opts.vaultRoot
    ? await chatWithAudit({
        llm: opts.llm,
        vaultRoot: opts.vaultRoot,
        consumer: "session-compress",
        request,
        env: opts.env,
      })
    : await opts.llm.chat(request);
  return {
    facts: parseCompressedFacts({
      content: response.content,
      rawRelPath: opts.rawRelPath,
      sessionId: opts.sessionId,
      observedAt: opts.observedAt,
      compressedAt: (opts.now ?? new Date()).toISOString(),
    }),
    ...(response.tokensUsed ? { tokensUsed: response.tokensUsed } : {}),
  };
}

export function parseCompressedFacts(opts: {
  content: string;
  rawRelPath: string;
  sessionId: string;
  observedAt: string;
  compressedAt: string;
}): CompressedFact[] {
  const json = extractJsonObject(opts.content);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const values = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { facts?: unknown }).facts)
    ? (parsed as { facts: unknown[] }).facts
    : [];
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
    sessionId: opts.sessionId,
    sourceRawPath: opts.rawRelPath.replace(/\\/g, "/"),
    observedAt: opts.observedAt,
    compressedAt: opts.compressedAt,
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

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf-8");
  if (buffer.byteLength <= maxBytes) return text;
  return `${buffer.subarray(0, maxBytes).toString("utf-8")}\n\n[truncated at ${maxBytes} bytes]`;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*\S+/gi, "$1=[REDACTED]")
    .replace(/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?^-----END [A-Z ]*PRIVATE KEY-----/gm, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]")
    .replace(/\bgh[posru]_[0-9A-Za-z]{36,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/g, "Bearer [REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]");
}
