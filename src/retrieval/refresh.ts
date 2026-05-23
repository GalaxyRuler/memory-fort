import { createHash } from "node:crypto";
import type { SearchDocument } from "./corpus.js";
import {
  loadEmbeddings,
  loadEmbeddingsMeta,
  saveEmbeddings,
  saveEmbeddingsMeta,
  type EmbeddingKind,
  type EmbeddingRecord,
} from "./embeddings-store.js";

export interface EmbedClient {
  embed(texts: string[]): Promise<{ vectors: number[][]; model: string; dim: number }>;
}

export interface RefreshOptions {
  memoryRoot: string;
  documents: SearchDocument[];
  embedClient: EmbedClient;
  batchSize?: number;
  timeoutMs?: number;
  now?: () => Date;
}

export interface RefreshResult {
  embedded: number;
  unchanged: number;
  pruned: number;
  errors: Array<{ path: string; reason: string }>;
  totalRecords: number;
}

interface PendingDoc {
  document: SearchDocument;
  hash: string;
}

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = "voyage-4-large";
const DEFAULT_DIM = 2048;

export async function refreshEmbeddings(opts: RefreshOptions): Promise<RefreshResult> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const now = opts.now ?? (() => new Date());
  const documentsByKind = groupDocumentsByKind(opts.documents);
  const meta = await loadEmbeddingsMeta(opts.memoryRoot);
  let expectedModel = meta?.model ?? DEFAULT_MODEL;
  let expectedDim = meta?.dim ?? DEFAULT_DIM;
  let metaCreatedAt = meta?.createdAt ?? now().toISOString();
  const result: RefreshResult = {
    embedded: 0,
    unchanged: 0,
    pruned: 0,
    errors: [],
    totalRecords: 0,
  };

  for (const kind of documentsByKind.keys()) {
    const documents = documentsByKind.get(kind) ?? [];
    const loaded = await loadEmbeddings(opts.memoryRoot, kind);
    for (const warning of loaded.warnings) {
      result.errors.push({
        path: `embeddings/${kind}.embeddings.jsonl:${warning.line}`,
        reason: warning.reason,
      });
    }

    const existingByPath = new Map(
      loaded.records.map((record) => [record.path, record] as const),
    );
    const knownPaths = new Set(documents.map((document) => document.relPath));
    const pending: PendingDoc[] = [];

    for (const document of documents) {
      const hash = hashText(document.body);
      const existing = existingByPath.get(document.relPath);
      if (
        existing &&
        existing.hash === hash &&
        existing.model === expectedModel &&
        existing.dim === expectedDim
      ) {
        result.unchanged += 1;
      } else {
        pending.push({ document, hash });
      }
    }

    for (const batch of chunk(pending, batchSize)) {
      try {
        const response = await withTimeout(
          opts.embedClient.embed(batch.map((item) => item.document.body)),
          timeoutMs,
        );
        if (response.vectors.length !== batch.length) {
          throw new Error(
            `embed response vector count ${response.vectors.length} did not match batch size ${batch.length}`,
          );
        }

        expectedModel = response.model;
        expectedDim = response.dim;
        const embeddedAt = now().toISOString();
        for (let index = 0; index < batch.length; index += 1) {
          const item = batch[index]!;
          existingByPath.set(item.document.relPath, {
            path: item.document.relPath,
            hash: item.hash,
            vector: response.vectors[index]!,
            model: response.model,
            dim: response.dim,
            ts: embeddedAt,
          });
        }
        result.embedded += batch.length;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const item of batch) {
          result.errors.push({ path: item.document.relPath, reason });
        }
      }
    }

    const records = [...existingByPath.values()].filter((record) => {
      if (knownPaths.has(record.path)) return true;
      result.pruned += 1;
      return false;
    });
    records.sort((a, b) => a.path.localeCompare(b.path));
    await saveEmbeddings(opts.memoryRoot, kind, records);
    result.totalRecords += records.length;
  }

  if (result.embedded > 0) {
    const updatedAt = now().toISOString();
    await saveEmbeddingsMeta(opts.memoryRoot, {
      provider: "voyage",
      model: expectedModel,
      dim: expectedDim,
      sdkVersion: "injected",
      createdAt: metaCreatedAt,
      updatedAt,
    });
  }

  return result;
}

function groupDocumentsByKind(documents: SearchDocument[]): Map<EmbeddingKind, SearchDocument[]> {
  const grouped = new Map<EmbeddingKind, SearchDocument[]>();
  for (const document of documents) {
    const kind = document.kind;
    grouped.set(kind, [...(grouped.get(kind) ?? []), document]);
  }
  return grouped;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`embedding batch timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
