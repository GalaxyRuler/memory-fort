import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  manifestMatches,
  readManifest,
  sha256Buffer,
  writeManifest,
  type LongMemEvalManifest,
} from "./manifest.js";

export const LONGMEMEVAL_S_DATASET = "longmemeval-s";
export const LONGMEMEVAL_S_SOURCE_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s";
export const LONGMEMEVAL_S_SHA256 =
  "08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894";
export const LONGMEMEVAL_S_VERSION = `sha256:${LONGMEMEVAL_S_SHA256}`;

export interface NormalizedLongMemEvalQuestion {
  question_id: string;
  question: string;
  expected_evidence_ids: string[];
  category: string;
  timestamp: string;
}

export interface DownloadLongMemEvalOptions {
  dataset?: "longmemeval-s";
  cacheDir?: string;
  fetchFn?: typeof fetch;
  expectedSha256?: string;
  now?: () => Date;
}

export interface DownloadLongMemEvalResult {
  status: "downloaded" | "skipped";
  datasetDir: string;
  questionsPath: string;
  manifestPath: string;
  manifest: LongMemEvalManifest;
}

export class LongMemEvalDownloadError extends Error {
  readonly exitCode = 1;

  constructor(message: string) {
    super(message);
    this.name = "LongMemEvalDownloadError";
  }
}

export function defaultDatasetCacheDir(): string {
  return join(homedir(), ".memory", "datasets");
}

export async function downloadLongMemEvalDataset(
  opts: DownloadLongMemEvalOptions = {},
): Promise<DownloadLongMemEvalResult> {
  const dataset = opts.dataset ?? LONGMEMEVAL_S_DATASET;
  if (dataset !== LONGMEMEVAL_S_DATASET) {
    throw new LongMemEvalDownloadError(
      `Unsupported dataset: ${dataset}. Supported dataset: longmemeval-s.`,
    );
  }

  const cacheDir = resolve(opts.cacheDir ?? defaultDatasetCacheDir());
  const datasetDir = join(cacheDir, LONGMEMEVAL_S_DATASET);
  const questionsPath = join(datasetDir, "questions.jsonl");
  const manifestPath = join(datasetDir, "manifest.json");
  const expectedSha256 = opts.expectedSha256 ?? LONGMEMEVAL_S_SHA256;
  const sourceUrl = LONGMEMEVAL_S_SOURCE_URL;
  const existingManifest = await readManifest(manifestPath);

  if (
    manifestMatches(existingManifest, expectedSha256, sourceUrl) &&
    existsSync(questionsPath)
  ) {
    return {
      status: "skipped",
      datasetDir,
      questionsPath,
      manifestPath,
      manifest: existingManifest,
    };
  }

  await mkdir(datasetDir, { recursive: true });

  let body: Buffer;
  try {
    const response = await (opts.fetchFn ?? fetch)(sourceUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    await clearPartialOutputs(questionsPath, manifestPath);
    throw new LongMemEvalDownloadError(
      `Unable to download LongMemEval-S from ${sourceUrl}: ${errorMessage(error)}\n` +
        "Manual download: save the official HuggingFace file to the cache, verify its SHA-256, " +
        "then rerun memory eval download.",
    );
  }

  const actualSha256 = sha256Buffer(body);
  if (actualSha256 !== expectedSha256) {
    await clearPartialOutputs(questionsPath, manifestPath);
    throw new LongMemEvalDownloadError(
      `LongMemEval-S hash mismatch: expected ${expectedSha256}, got ${actualSha256}. ` +
        "Deleted partial output; retry or manually verify the official HuggingFace file.",
    );
  }

  let questions: NormalizedLongMemEvalQuestion[];
  try {
    questions = normalizeLongMemEvalRows(JSON.parse(body.toString("utf-8")));
  } catch (error) {
    await clearPartialOutputs(questionsPath, manifestPath);
    throw new LongMemEvalDownloadError(
      `LongMemEval-S normalization failed: ${errorMessage(error)}`,
    );
  }

  await writeFile(
    questionsPath,
    `${questions.map((question) => JSON.stringify(question)).join("\n")}\n`,
    "utf-8",
  );
  const manifest: LongMemEvalManifest = {
    dataset: LONGMEMEVAL_S_DATASET,
    version: LONGMEMEVAL_S_VERSION,
    sha256: expectedSha256,
    sourceUrl,
    downloadedAt: (opts.now ?? (() => new Date()))().toISOString(),
    questionCount: questions.length,
  };
  await writeManifest(manifestPath, manifest);

  return {
    status: "downloaded",
    datasetDir,
    questionsPath,
    manifestPath,
    manifest,
  };
}

export function normalizeLongMemEvalRows(
  rows: unknown,
): NormalizedLongMemEvalQuestion[] {
  if (!Array.isArray(rows)) {
    throw new Error("expected upstream JSON array");
  }

  return rows.map((row, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`row ${index} is not an object`);
    }
    const record = row as Record<string, unknown>;
    const questionId = readString(record.question_id) ?? readString(record.id);
    const question = readString(record.question);
    const expected = readStringArray(record.answer_session_ids)
      ?? readStringArray(record.evidence_session_ids)
      ?? readStringArray(record.expected_evidence_ids)
      ?? readStringArray(record.expected);
    if (!questionId) throw new Error(`row ${index} missing question_id`);
    if (!question) throw new Error(`row ${index} missing question`);
    if (!expected || expected.length === 0) {
      throw new Error(`row ${index} missing answer_session_ids`);
    }

    return {
      question_id: questionId,
      question,
      expected_evidence_ids: expected,
      category: readString(record.question_type) ?? readString(record.category) ?? "unknown",
      timestamp: readString(record.question_date) ?? readString(record.timestamp) ?? "",
    };
  });
}

async function clearPartialOutputs(
  questionsPath: string,
  manifestPath: string,
): Promise<void> {
  await Promise.all([
    rm(questionsPath, { force: true }),
    rm(manifestPath, { force: true }),
  ]);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return strings.length > 0 ? strings : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}
