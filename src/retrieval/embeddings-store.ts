import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";

export type EmbeddingKind = "wiki" | "raw" | "crystal";

export interface EmbeddingRecord {
  path: string;
  hash: string;
  vector: number[];
  model: string;
  dim: number;
  ts: string;
}

export interface EmbeddingsMeta {
  provider: string;
  model: string;
  dim: number;
  sdkVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoadEmbeddingsResult {
  records: EmbeddingRecord[];
  warnings: Array<{ line: number; reason: string }>;
}

const EMBEDDING_FILENAMES: Record<EmbeddingKind, string> = {
  wiki: "wiki.embeddings.jsonl",
  raw: "raw.embeddings.jsonl",
  crystal: "crystal.embeddings.jsonl",
};

export async function loadEmbeddings(
  memoryRoot: string,
  kind: EmbeddingKind,
): Promise<LoadEmbeddingsResult> {
  const path = embeddingsPath(memoryRoot, kind);
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return { records: [], warnings: [] };
    throw error;
  }

  const warnings: LoadEmbeddingsResult["warnings"] = [];
  const byPath = new Map<string, EmbeddingRecord>();
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.trim().length === 0) return;
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = validateEmbeddingRecord(parsed);
      const existing = byPath.get(record.path);
      if (!existing || Date.parse(record.ts) >= Date.parse(existing.ts)) {
        byPath.set(record.path, record);
      }
    } catch (error) {
      warnings.push({
        line: index + 1,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { records: [...byPath.values()], warnings };
}

export async function saveEmbeddings(
  memoryRoot: string,
  kind: EmbeddingKind,
  records: EmbeddingRecord[],
): Promise<void> {
  const content =
    records.length === 0 ? "" : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await atomicWrite(embeddingsPath(memoryRoot, kind), content);
}

export async function removeStale(
  memoryRoot: string,
  kind: EmbeddingKind,
  knownPaths: Set<string>,
): Promise<{ removed: number }> {
  const { records } = await loadEmbeddings(memoryRoot, kind);
  const kept = records.filter((record) => knownPaths.has(record.path));
  await saveEmbeddings(memoryRoot, kind, kept);
  return { removed: records.length - kept.length };
}

export async function loadEmbeddingsMeta(
  memoryRoot: string,
): Promise<EmbeddingsMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(metaPath(memoryRoot), "utf-8")) as unknown;
    return validateEmbeddingsMeta(parsed);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function saveEmbeddingsMeta(
  memoryRoot: string,
  meta: EmbeddingsMeta,
): Promise<void> {
  await atomicWrite(metaPath(memoryRoot), `${JSON.stringify(meta, null, 2)}\n`);
}

function embeddingsPath(memoryRoot: string, kind: EmbeddingKind): string {
  return join(memoryRoot, "embeddings", EMBEDDING_FILENAMES[kind]);
}

function metaPath(memoryRoot: string): string {
  return join(memoryRoot, "embeddings", "embeddings.meta.json");
}

function validateEmbeddingRecord(value: unknown): EmbeddingRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("record must be an object");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || record.path.length === 0) {
    throw new Error("record.path must be a non-empty string");
  }
  if (typeof record.hash !== "string" || record.hash.length === 0) {
    throw new Error("record.hash must be a non-empty string");
  }
  if (
    !Array.isArray(record.vector) ||
    !record.vector.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    throw new Error("record.vector must be an array of numbers");
  }
  if (typeof record.model !== "string" || record.model.length === 0) {
    throw new Error("record.model must be a non-empty string");
  }
  if (typeof record.dim !== "number" || !Number.isFinite(record.dim)) {
    throw new Error("record.dim must be a number");
  }
  if (typeof record.ts !== "string" || record.ts.length === 0) {
    throw new Error("record.ts must be a non-empty string");
  }

  return record as unknown as EmbeddingRecord;
}

function validateEmbeddingsMeta(value: unknown): EmbeddingsMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("meta must be an object");
  }
  const meta = value as Record<string, unknown>;
  for (const key of ["provider", "model", "sdkVersion", "createdAt", "updatedAt"]) {
    if (typeof meta[key] !== "string" || meta[key].length === 0) {
      throw new Error(`meta.${key} must be a non-empty string`);
    }
  }
  if (typeof meta.dim !== "number" || !Number.isFinite(meta.dim)) {
    throw new Error("meta.dim must be a number");
  }
  return meta as unknown as EmbeddingsMeta;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
