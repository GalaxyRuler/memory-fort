import type { SearchDocument } from "./corpus.js";
import {
  assertEmbeddingsWritable,
  loadEmbeddings,
  loadEmbeddingsMeta,
  saveEmbeddings,
  saveEmbeddingsMeta,
  type EmbeddingKind,
  type EmbeddingRecord,
  type LoadEmbeddingsResult,
} from "./embeddings-store.js";
import {
  embedWithClient,
  isEmbedder,
  type EmbedClient,
  type EmbedResult,
} from "./embedder/types.js";
import { VoyageRateLimitedError } from "./embedder/voyage.js";
import {
  EMBEDDING_BATCH_TOKEN_LIMIT,
  estimateEmbeddingTokens,
  hashEmbeddingBody,
  toEmbeddingText,
} from "./embedding-text.js";

export { type EmbedClient } from "./embedder/types.js";

export interface RefreshOptions {
  memoryRoot: string;
  documents: SearchDocument[];
  embedClient: EmbedClient;
  embeddingsLoader?: EmbeddingsLoader;
  batchSize?: number;
  timeoutMs?: number;
  expectedDim?: number;
  rateLimitMaxRetries?: number;
  rateLimitBaseDelayMs?: number;
  maxPending?: number;
  preserveUnknownRecords?: boolean;
  onEmbedBatchStart?: (batch: RefreshEmbeddingBatch) => Promise<void> | void;
  onEmbedBatchSuccess?: (batch: RefreshEmbeddingBatch, response: EmbedResult) => Promise<void> | void;
  onEmbedBatchError?: (batch: RefreshEmbeddingBatch, error: unknown) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type EmbeddingsLoader = (
  memoryRoot: string,
  kind: EmbeddingKind,
) => Promise<LoadEmbeddingsResult>;

export interface RefreshResult {
  embedded: number;
  unchanged: number;
  pruned: number;
  errors: Array<{ path: string; reason: string }>;
  totalRecords: number;
  failedBatches?: number;
  inputTokens?: number;
  skippedPending?: number;
}

export interface RefreshEmbeddingBatch {
  documents: Array<{ path: string; tokenEstimate: number }>;
  tokenEstimate: number;
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

export interface PlanEmbeddingsRefreshOptions {
  memoryRoot: string;
  documents: SearchDocument[];
  expectedDim?: number;
  expectedModel?: string;
}

export interface PlanEmbeddingsRefreshResult {
  corpusDocumentCount: number;
  pendingDocuments: number;
  unchanged: number;
  pruned: number;
  tokenEstimate: number;
  errors: Array<{ path: string; reason: string }>;
}

export async function planEmbeddingsRefresh(
  opts: PlanEmbeddingsRefreshOptions,
): Promise<PlanEmbeddingsRefreshResult> {
  const expectedDim = readPositiveInteger(opts.expectedDim) ?? DEFAULT_DIM;
  const expectedModel = opts.expectedModel ?? DEFAULT_MODEL;
  const documentsByKind = groupDocumentsByKind(opts.documents);
  const result: PlanEmbeddingsRefreshResult = {
    corpusDocumentCount: opts.documents.length,
    pendingDocuments: 0,
    unchanged: 0,
    pruned: 0,
    tokenEstimate: 0,
    errors: [],
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
    for (const document of documents) {
      const text = toEmbeddingText(document.body);
      const hash = hashEmbeddingBody(document.body);
      const existing = existingByPath.get(document.relPath);
      if (
        existing &&
        existing.hash === hash &&
        existing.model === expectedModel &&
        existing.dim === expectedDim
      ) {
        result.unchanged += 1;
      } else {
        result.pendingDocuments += 1;
        result.tokenEstimate += estimateEmbeddingTokens(text);
      }
    }

    result.pruned += countPrunableRecords(loaded.records, knownPaths, expectedDim);
  }

  return result;
}

export async function refreshEmbeddings(opts: RefreshOptions): Promise<RefreshResult> {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const expectedDim = readPositiveInteger(opts.expectedDim) ?? expectedDimFromClient(opts.embedClient);
  const maxPending = readNonNegativeInteger(opts.maxPending) ?? Number.POSITIVE_INFINITY;
  const maxRateLimitRetries = readNonNegativeInteger(opts.rateLimitMaxRetries)
    ?? DEFAULT_RATE_LIMIT_MAX_RETRIES;
  const rateLimitBaseDelayMs = readPositiveInteger(opts.rateLimitBaseDelayMs)
    ?? DEFAULT_RATE_LIMIT_BASE_DELAY_MS;
  const sleep = opts.sleep ?? sleepMs;
  const now = opts.now ?? (() => new Date());
  const embeddingsLoader = opts.embeddingsLoader ?? loadEmbeddings;
  const documentsByKind = groupDocumentsByKind(opts.documents);
  const meta = await loadEmbeddingsMeta(opts.memoryRoot);
  let expectedModel = expectedModelFromClient(opts.embedClient) ?? meta?.model ?? DEFAULT_MODEL;
  let metaCreatedAt = meta?.createdAt ?? now().toISOString();
  const result: RefreshResult = {
    embedded: 0,
    unchanged: 0,
    pruned: 0,
    errors: [],
    totalRecords: 0,
  };
  let remainingPendingBudget = maxPending;

  for (const kind of documentsByKind.keys()) {
    const documents = documentsByKind.get(kind) ?? [];
    const loaded = await embeddingsLoader(opts.memoryRoot, kind);
    const errorsBeforeKind = result.errors.length;
    for (const warning of loaded.warnings) {
      result.errors.push({
        path: `embeddings/${kind}.embeddings.jsonl:${warning.line}`,
        reason: warning.reason,
      });
    }
    if (result.errors.length > errorsBeforeKind) continue;

    const existingByPath = new Map(
      loaded.records.map((record) => [record.path, record] as const),
    );
    const knownPaths = new Set(documents.map((document) => document.relPath));
    const pendingCandidates: PendingDoc[] = [];

    for (const document of documents) {
      const text = toEmbeddingText(document.body);
      const hash = hashEmbeddingBody(document.body);
      const existing = existingByPath.get(document.relPath);
      if (
        existing &&
        existing.hash === hash &&
        existing.model === expectedModel &&
        existing.dim === expectedDim
      ) {
        result.unchanged += 1;
      } else {
        pendingCandidates.push({
          document,
          hash,
          text,
          tokenEstimate: estimateEmbeddingTokens(text),
        });
      }
    }

    const pendingLimit = Number.isFinite(remainingPendingBudget)
      ? Math.max(0, remainingPendingBudget)
      : pendingCandidates.length;
    const pending = pendingCandidates.slice(0, pendingLimit);
    const skippedForKind = pendingCandidates.length - pending.length;
    if (skippedForKind > 0) {
      result.skippedPending = (result.skippedPending ?? 0) + skippedForKind;
    }
    if (Number.isFinite(remainingPendingBudget)) {
      remainingPendingBudget = Math.max(0, remainingPendingBudget - pending.length);
    }

    let savedForKind = false;
    let kindHadBatchError = false;
    for (const batch of buildEmbeddingBatches(pending, batchSize)) {
      const batchInfo: RefreshEmbeddingBatch = {
        documents: batch.map((item) => ({
          path: item.document.relPath,
          tokenEstimate: item.tokenEstimate,
        })),
        tokenEstimate: batch.reduce((sum, item) => sum + item.tokenEstimate, 0),
      };
      try {
        await opts.onEmbedBatchStart?.(batchInfo);
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
        const recordsForKind = recordsForSave(existingByPath, knownPaths, expectedDim, {
          preserveUnknownRecords: opts.preserveUnknownRecords === true,
        });
        await saveEmbeddings(opts.memoryRoot, kind, recordsForKind.records, { expectedDim });
        savedForKind = true;
        await saveEmbeddingsMeta(opts.memoryRoot, {
          provider: providerName(opts.embedClient),
          model: expectedModel,
          dim: expectedDim,
          sdkVersion: "injected",
          createdAt: metaCreatedAt,
          updatedAt: now().toISOString(),
        });
        await opts.onEmbedBatchSuccess?.(batchInfo, response);
      } catch (error) {
        await opts.onEmbedBatchError?.(batchInfo, error);
        const reason = error instanceof Error ? error.message : String(error);
        result.failedBatches = (result.failedBatches ?? 0) + 1;
        for (const item of batch) {
          result.errors.push({ path: item.document.relPath, reason });
        }
        kindHadBatchError = true;
        break;
      }
    }

    const recordsForKind = recordsForSave(existingByPath, knownPaths, expectedDim, {
      preserveUnknownRecords: opts.preserveUnknownRecords === true,
    });
    if (!kindHadBatchError && !savedForKind && recordsForKind.pruned > 0) {
      await saveEmbeddings(opts.memoryRoot, kind, recordsForKind.records, { expectedDim });
      savedForKind = true;
    }
    if (savedForKind || !kindHadBatchError) {
      result.pruned += recordsForKind.pruned;
      result.totalRecords += recordsForKind.records.length;
    } else {
      result.totalRecords += loaded.records.length;
    }
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

function expectedModelFromClient(embedClient: EmbedClient): string | undefined {
  return isEmbedder(embedClient) && embedClient.modelName.length > 0
    ? embedClient.modelName
    : undefined;
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

function recordsForSave(
  existingByPath: Map<string, EmbeddingRecord>,
  knownPaths: Set<string>,
  expectedDim: number,
  opts: { preserveUnknownRecords?: boolean } = {},
): { records: EmbeddingRecord[]; pruned: number } {
  let pruned = 0;
  const records = [...existingByPath.values()].filter((record) => {
    if (knownPaths.has(record.path)) return true;
    if (opts.preserveUnknownRecords) return true;
    if (record.archived && isWritableEmbeddingRecord(record, expectedDim)) return true;
    pruned += 1;
    return false;
  });
  records.sort((a, b) => a.path.localeCompare(b.path));
  return { records, pruned };
}

function countPrunableRecords(
  records: EmbeddingRecord[],
  knownPaths: Set<string>,
  expectedDim: number,
): number {
  return records.filter((record) => {
    if (knownPaths.has(record.path)) return false;
    if (record.archived && isWritableEmbeddingRecord(record, expectedDim)) return false;
    return true;
  }).length;
}

function buildEmbeddingBatches(items: PendingDoc[], maxDocs: number): PendingDoc[][] {
  const batches: PendingDoc[][] = [];
  let current: PendingDoc[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const wouldExceedDocs = current.length >= maxDocs;
    const wouldExceedTokens =
      current.length > 0 &&
      currentTokens + item.tokenEstimate > EMBEDDING_BATCH_TOKEN_LIMIT;

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
