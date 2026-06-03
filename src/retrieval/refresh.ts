import { createHash } from "node:crypto";
import type { SearchDocument } from "./corpus.js";
import {
  assertEmbeddingsWritable,
  loadEmbeddings,
  loadEmbeddingsMeta,
  saveEmbeddings,
  saveEmbeddingsMeta,
  type EmbeddingKind,
  type EmbeddingRecord,
} from "./embeddings-store.js";
import {
  embedWithClient,
  isEmbedder,
  type EmbedClient,
  type EmbedResult,
} from "./embedder/types.js";
import { VoyageRateLimitedError } from "./embedder/voyage.js";

export { type EmbedClient } from "./embedder/types.js";

export interface RefreshOptions {
  memoryRoot: string;
  documents: SearchDocument[];
  embedClient: EmbedClient;
  batchSize?: number;
  timeoutMs?: number;
  expectedDim?: number;
  rateLimitMaxRetries?: number;
  rateLimitBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface RefreshResult {
  embedded: number;
  unchanged: number;
  pruned: number;
  errors: Array<{ path: string; reason: string }>;
  totalRecords: number;
  failedBatches?: number;
  inputTokens?: number;
}

interface PendingDoc {
  document: SearchDocument;
  hash: string;
  text: string;
  tokenEstimate: number;
}

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_MAX_RETRIES = 3;
const DEFAULT_RATE_LIMIT_BASE_DELAY_MS = 1_000;
const DEFAULT_MODEL = "voyage-4-large";
const DEFAULT_DIM = 2048;
const VOYAGE_PER_DOC_TOKEN_LIMIT = 30_000;
const VOYAGE_BATCH_TOKEN_LIMIT = 100_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

export async function refreshEmbeddings(opts: RefreshOptions): Promise<RefreshResult> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const expectedDim = readPositiveInteger(opts.expectedDim) ?? expectedDimFromClient(opts.embedClient);
  const maxRateLimitRetries = readNonNegativeInteger(opts.rateLimitMaxRetries)
    ?? DEFAULT_RATE_LIMIT_MAX_RETRIES;
  const rateLimitBaseDelayMs = readPositiveInteger(opts.rateLimitBaseDelayMs)
    ?? DEFAULT_RATE_LIMIT_BASE_DELAY_MS;
  const sleep = opts.sleep ?? sleepMs;
  const now = opts.now ?? (() => new Date());
  const documentsByKind = groupDocumentsByKind(opts.documents);
  const meta = await loadEmbeddingsMeta(opts.memoryRoot);
  let expectedModel = meta?.model ?? DEFAULT_MODEL;
  let metaCreatedAt = meta?.createdAt ?? now().toISOString();
  const result: RefreshResult = {
    embedded: 0,
    unchanged: 0,
    pruned: 0,
    errors: [],
    totalRecords: 0,
  };
  const proposedRecordsByKind = new Map<EmbeddingKind, EmbeddingRecord[]>();
  let proposedPruned = 0;

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
      const text = truncateToTokens(document.body, VOYAGE_PER_DOC_TOKEN_LIMIT);
      const hash = hashText(text);
      const existing = existingByPath.get(document.relPath);
      if (
        existing &&
        existing.hash === hash &&
        existing.model === expectedModel &&
        existing.dim === expectedDim
      ) {
        result.unchanged += 1;
      } else {
        pending.push({
          document,
          hash,
          text,
          tokenEstimate: estimateTokens(text),
        });
      }
    }

    for (const batch of buildEmbeddingBatches(pending, batchSize)) {
      try {
        const response = await embedBatchWithRateLimitRetry(
          () =>
            withTimeout(
              embedWithClient(opts.embedClient, {
                texts: batch.map((item) => item.text),
              }),
              timeoutMs,
            ),
          {
            maxRetries: maxRateLimitRetries,
            baseDelayMs: rateLimitBaseDelayMs,
            sleep,
          },
        );
        const records = buildBatchRecords(batch, response, now().toISOString());
        assertEmbeddingsWritable(records, expectedDim);

        expectedModel = response.model;
        if (typeof response.inputTokens === "number" && response.inputTokens > 0) {
          result.inputTokens = (result.inputTokens ?? 0) + response.inputTokens;
        }
        for (const record of records) {
          existingByPath.set(record.path, record);
        }
        result.embedded += batch.length;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.failedBatches = (result.failedBatches ?? 0) + 1;
        for (const item of batch) {
          result.errors.push({ path: item.document.relPath, reason });
        }
      }
    }

    let prunedForKind = 0;
    const records = [...existingByPath.values()].filter((record) => {
      if (knownPaths.has(record.path)) return true;
      if (record.archived && isWritableEmbeddingRecord(record, expectedDim)) return true;
      prunedForKind += 1;
      return false;
    });
    records.sort((a, b) => a.path.localeCompare(b.path));
    proposedRecordsByKind.set(kind, records);
    proposedPruned += prunedForKind;
  }

  if (result.errors.length > 0) {
    return result;
  }

  for (const [kind, records] of proposedRecordsByKind) {
    await saveEmbeddings(opts.memoryRoot, kind, records, { expectedDim });
    result.totalRecords += records.length;
  }
  result.pruned = proposedPruned;

  if (result.embedded > 0) {
    const updatedAt = now().toISOString();
    await saveEmbeddingsMeta(opts.memoryRoot, {
      provider: providerName(opts.embedClient),
      model: expectedModel,
      dim: expectedDim,
      sdkVersion: "injected",
      createdAt: metaCreatedAt,
      updatedAt,
    });
  }

  return result;
}

function buildBatchRecords(
  batch: PendingDoc[],
  response: EmbedResult,
  embeddedAt: string,
): EmbeddingRecord[] {
  if (response.vectors.length !== batch.length) {
    throw new Error(
      `embed response vector count ${response.vectors.length} did not match batch size ${batch.length}`,
    );
  }
  return batch.map((item, index) => ({
    path: item.document.relPath,
    hash: item.hash,
    vector: response.vectors[index]!,
    model: response.model,
    dim: response.dim,
    ts: embeddedAt,
  }));
}

async function embedBatchWithRateLimitRetry(
  operation: () => Promise<EmbedResult>,
  opts: {
    maxRetries: number;
    baseDelayMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<EmbedResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isVoyageRateLimited(error) || attempt >= opts.maxRetries) {
        throw error;
      }
      await opts.sleep(opts.baseDelayMs * 2 ** attempt);
    }
  }
}

function isVoyageRateLimited(error: unknown): boolean {
  return error instanceof VoyageRateLimitedError ||
    (error instanceof Error && error.name === "VoyageRateLimitedError");
}

function isWritableEmbeddingRecord(record: EmbeddingRecord, expectedDim: number): boolean {
  try {
    assertEmbeddingsWritable([record], expectedDim);
    return true;
  } catch {
    return false;
  }
}

function expectedDimFromClient(embedClient: EmbedClient): number {
  return isEmbedder(embedClient) && Number.isInteger(embedClient.dim) && embedClient.dim > 0
    ? embedClient.dim
    : DEFAULT_DIM;
}

function providerName(embedClient: EmbedClient): string {
  return isEmbedder(embedClient) ? embedClient.providerName : "voyage";
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE;
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > maxChars * 0.9 ? truncated.slice(0, lastSpace) : truncated;
}

function buildEmbeddingBatches(items: PendingDoc[], maxDocs: number): PendingDoc[][] {
  const batches: PendingDoc[][] = [];
  let current: PendingDoc[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const wouldExceedDocs = current.length >= maxDocs;
    const wouldExceedTokens =
      current.length > 0 &&
      currentTokens + item.tokenEstimate > VOYAGE_BATCH_TOKEN_LIMIT;

    if (wouldExceedDocs || wouldExceedTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(item);
    currentTokens += item.tokenEstimate;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
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

function readPositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function readNonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
