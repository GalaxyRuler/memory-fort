import { createHash } from "node:crypto";
import { setImmediate as yieldImmediate } from "node:timers/promises";

import {
  ingestChunkVector,
  ingestChunkVectorsBatch,
  type EmbedClient,
  type EmbeddingProfileFingerprint,
  type IngestChunkVectorResult,
} from "./embed.js";
import type { SqliteDatabase } from "./db.js";

export interface BackfillVectorsOptions {
  readonly embedder: EmbedClient;
  readonly profile: EmbeddingProfileFingerprint;
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
  readonly nowMs?: number | (() => number);
}

export interface BackfillVectorsResult {
  readonly cancelled: boolean;
  readonly processed: number;
  readonly embedded: number;
  readonly reused: number;
  readonly failed: number;
  readonly stale: number;
}

interface CandidateChunkRow {
  readonly rowid: number;
}

interface CandidateScanRow {
  readonly rowid: number;
  readonly headingPath: string | null;
  readonly text: string;
  readonly status: string | null;
  readonly embeddedPayloadHash: string | null;
}

interface CandidateSelection {
  readonly candidates: CandidateChunkRow[];
  readonly lastScannedRowid: number;
  readonly exhausted: boolean;
}

interface MetaRow {
  readonly value: string | null;
}

const DEFAULT_BATCH_SIZE = 16;
const MIN_SCAN_WINDOW = 128;

export async function backfillVectors(
  database: SqliteDatabase,
  opts: BackfillVectorsOptions,
): Promise<BackfillVectorsResult> {
  const batchSize = positiveInteger(opts.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
  const totals = { processed: 0, embedded: 0, reused: 0, failed: 0, stale: 0 };
  let changed = false;
  let afterRowid = 0;

  const finish = (cancelled: boolean): BackfillVectorsResult => {
    if (changed) advanceVectorGeneration(database);
    return { cancelled, ...totals };
  };

  while (!opts.signal?.aborted) {
    const selection = selectBackfillCandidates(database, opts.profile.profileId, batchSize, afterRowid);
    const candidates = selection.candidates;
    if (candidates.length === 0) {
      afterRowid = selection.lastScannedRowid;
      if (selection.exhausted) break;
      await yieldImmediate();
      continue;
    }

    if (opts.signal) {
      for (const candidate of candidates) {
        if (opts.signal.aborted) {
          return finish(true);
        }
        const result = await ingestChunkVector({
          database,
          chunkRowid: candidate.rowid,
          profile: opts.profile,
          embedder: opts.embedder,
          nowMs: readNowMs(opts.nowMs),
        });
        countResult(totals, result);
        changed ||= result.status === "embedded" || result.status === "failed";
        if (opts.signal.aborted) {
          return finish(true);
        }
      }
    } else {
      const results = await ingestChunkVectorsBatch({
        database,
        chunkRowids: candidates.map((candidate) => candidate.rowid),
        profile: opts.profile,
        embedder: opts.embedder,
        nowMs: readNowMs(opts.nowMs),
      });
      for (const result of results) {
        countResult(totals, result);
        changed ||= result.status === "embedded" || result.status === "failed";
      }
    }

    afterRowid = selection.lastScannedRowid;
    await yieldImmediate();
  }

  return finish(Boolean(opts.signal?.aborted));
}

function selectBackfillCandidates(
  database: SqliteDatabase,
  profileId: string,
  batchSize: number,
  afterRowid: number,
): CandidateSelection {
  const scanWindow = Math.max(MIN_SCAN_WINDOW, batchSize * 8);
  const candidates: CandidateChunkRow[] = [];

  const rows = database
    .prepare<[string, number, number], CandidateScanRow>(
      `SELECT c.rowid, c.headingPath, c.text, v.status, v.embeddedPayloadHash
       FROM chunks c
       LEFT JOIN chunk_vectors v ON v.chunkRowid = c.rowid AND v.profileId = ?
       WHERE c.rowid > ?
       ORDER BY c.rowid
       LIMIT ?`,
    )
    .all(profileId, afterRowid, scanWindow);
  let cursor = afterRowid;

  for (const row of rows) {
    cursor = row.rowid;
    if (needsEmbedding(row)) {
      candidates.push({ rowid: row.rowid });
      if (candidates.length >= batchSize) break;
    }
  }

  return { candidates, lastScannedRowid: cursor, exhausted: rows.length < scanWindow };
}

function needsEmbedding(row: CandidateScanRow): boolean {
  if (row.status === null || row.status === "pending" || row.status === "failed") return true;
  return row.embeddedPayloadHash !== embeddedPayloadHash(row);
}

function countResult(
  totals: { processed: number; embedded: number; reused: number; failed: number; stale: number },
  result: IngestChunkVectorResult,
): void {
  totals.processed += 1;
  if (result.status === "embedded") totals.embedded += 1;
  else if (result.status === "reused") totals.reused += 1;
  else if (result.status === "stale") totals.stale += 1;
  else totals.failed += 1;
}

function advanceVectorGeneration(database: SqliteDatabase): void {
  const current = Number.parseInt(readMeta(database, "vectorGeneration") ?? "0", 10);
  const next = Number.isFinite(current) ? current + 1 : 1;
  database
    .prepare<[string, string]>(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run("vectorGeneration", String(next));
}

function readMeta(database: SqliteDatabase, key: string): string | null {
  return database.prepare<[string], MetaRow>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

function readNowMs(nowMs: number | (() => number) | undefined): number | undefined {
  return typeof nowMs === "function" ? nowMs() : nowMs;
}

function embeddedPayloadHash(row: Pick<CandidateScanRow, "headingPath" | "text">): string {
  const heading = row.headingPath?.trim();
  const payload = heading ? `${heading}\n\n${row.text}` : row.text;
  return createHash("sha256").update(payload).digest("hex");
}

function positiveInteger(value: number, name: string): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(value) || integer < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return integer;
}
