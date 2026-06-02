import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";

export const COMPRESSED_FACT_TYPES = [
  "project",
  "decision",
  "procedure",
  "lesson",
  "reference",
  "tool",
  "people",
  "fact",
] as const;

export type CompressedFactType = typeof COMPRESSED_FACT_TYPES[number];

export interface CompressedFact {
  title: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  files: string[];
  importance: number;
  type?: CompressedFactType;
  sessionId: string;
  sourceRawPath: string;
  observedAt: string;
  compressedAt: string;
  sampledChunks?: number;
  totalChunks?: number;
}

export interface CompressedFactFile {
  version: 1;
  sourceRawPath: string;
  sessionId: string;
  observedAt: string;
  compressedAt: string;
  sampledChunks?: number;
  totalChunks?: number;
  chunksCompressed?: number;
  inputTokens?: number;
  facts: CompressedFact[];
}

export function factFileRelPath(rawRelPath: string, sessionId: string): string {
  const normalized = rawRelPath.replace(/\\/g, "/");
  const date = /^raw\/(\d{4}-\d{2}-\d{2})\//.exec(normalized)?.[1] ?? "unknown-date";
  const rawName = basename(normalized, ".md");
  const slug = safeFactSlug(sessionId || rawName);
  return `facts/${date}/${slug}.json`;
}

export async function writeCompressedFactFile(vaultRoot: string, file: CompressedFactFile): Promise<string> {
  const relPath = factFileRelPath(file.sourceRawPath, file.sessionId);
  await atomicWrite(join(vaultRoot, ...relPath.split("/")), `${JSON.stringify(file, null, 2)}\n`);
  return relPath;
}

export async function loadCompressedFacts(vaultRoot: string): Promise<CompressedFact[]> {
  const factsRoot = join(vaultRoot, "facts");
  if (!existsSync(factsRoot)) return [];
  const files = await listJsonFiles(factsRoot);
  const facts: CompressedFact[] = [];
  for (const fullPath of files) {
    const parsed = readCompressedFactFile(await readFile(fullPath, "utf-8"));
    facts.push(...parsed);
  }
  return facts;
}

export function readCompressedFactFile(content: string): CompressedFact[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const candidates = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { facts?: unknown }).facts)
    ? (parsed as { facts: unknown[] }).facts
    : Array.isArray(parsed)
      ? parsed
      : [];
  return candidates.map(readFact).filter((fact): fact is CompressedFact => fact !== null);
}

async function listJsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

function readFact(value: unknown): CompressedFact | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = readString(record.title);
  const narrative = readString(record.narrative);
  const sessionId = readString(record.sessionId);
  const sourceRawPath = readString(record.sourceRawPath);
  const observedAt = readString(record.observedAt);
  const compressedAt = readString(record.compressedAt);
  const importance = typeof record.importance === "number" && Number.isFinite(record.importance)
    ? Math.max(1, Math.min(10, Math.round(record.importance)))
    : null;
  const facts = readStringArray(record.facts);
  const concepts = readStringArray(record.concepts);
  if (!title || !narrative || !sessionId || !sourceRawPath || !observedAt || !compressedAt || importance === null || facts.length === 0 || concepts.length === 0) {
    return null;
  }
  return {
    title,
    facts,
    narrative,
    concepts,
    files: readStringArray(record.files),
    importance,
    ...readOptionalFactType(record.type),
    sessionId,
    sourceRawPath: sourceRawPath.replace(/\\/g, "/"),
    observedAt,
    compressedAt,
    ...readOptionalPositiveInteger(record.sampledChunks, "sampledChunks"),
    ...readOptionalPositiveInteger(record.totalChunks, "totalChunks"),
  };
}

export function readCompressedFactType(value: unknown): CompressedFactType | null {
  return typeof value === "string" && (COMPRESSED_FACT_TYPES as readonly string[]).includes(value)
    ? value as CompressedFactType
    : null;
}

function readOptionalFactType(value: unknown): { type: CompressedFactType } | Record<string, never> {
  const type = readCompressedFactType(value);
  return type ? { type } : {};
}

function readOptionalPositiveInteger(value: unknown, key: "sampledChunks" | "totalChunks"): Record<string, number> {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? { [key]: value } : {};
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

function safeFactSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "session";
}
