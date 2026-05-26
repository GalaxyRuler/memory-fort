import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readManifest } from "./manifest.js";
import { hitAtK, recallAtK } from "./scoring.js";
import type {
  LongMemEvalQuestion,
  LongMemEvalReport,
  RunLongMemEvalOptions,
} from "./types.js";
import { runSearch } from "../../retrieval/search.js";
import type { EmbedClient } from "../../retrieval/refresh.js";
import type { VoyageClient } from "../../retrieval/voyage-client.js";

const DEFAULT_K = [1, 5, 10];

export async function runLongMemEval(
  opts: RunLongMemEvalOptions,
): Promise<LongMemEvalReport> {
  const startedAtDate = new Date();
  const startedMs = Date.now();
  const kValues = normalizeK(opts.k);
  const maxK = Math.max(...kValues);
  const questions = applyLimit(
    await loadLongMemEvalQuestions(opts.datasetPath),
    opts.limit,
  );
  const manifest = await readManifest(`${dirname(opts.datasetPath)}/manifest.json`);
  const searchConfig = withDefaultSearchConfig(opts.searchConfig);

  const perQuestion: LongMemEvalReport["perQuestion"] = [];
  for (const question of questions) {
    const response = await runSearch({
      ...searchConfig,
      query: question.question,
      scope: "all",
      k: maxK,
      vaultRoot: opts.vaultRoot,
    });
    const retrieved = response.results.map((result) => result.path);
    const hits = Object.fromEntries(
      kValues.map((k) => [
        k,
        hitAtK(question.expected_evidence_ids, retrieved, k),
      ]),
    ) as Record<number, boolean>;
    perQuestion.push({
      questionId: question.question_id,
      question: question.question,
      expected: question.expected_evidence_ids,
      retrieved,
      hits,
      latencyMs: response.timings.totalMs,
    });
  }

  const finishedAtDate = new Date();
  const latencyValues = perQuestion.map((question) => question.latencyMs);
  return {
    startedAt: startedAtDate.toISOString(),
    finishedAt: finishedAtDate.toISOString(),
    durationMs: Math.max(0, Date.now() - startedMs),
    vaultRoot: opts.vaultRoot,
    datasetVersion: manifest?.version ?? "unknown",
    questionCount: perQuestion.length,
    recall: Object.fromEntries(
      kValues.map((k) => [
        k,
        recallAtK(perQuestion, k),
      ]),
    ) as Record<number, number>,
    meanLatencyMs: mean(latencyValues),
    p95LatencyMs: percentile(latencyValues, 95),
    perQuestion,
  };
}

export async function loadLongMemEvalQuestions(
  datasetPath: string,
): Promise<LongMemEvalQuestion[]> {
  const text = await readFile(datasetPath, "utf-8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => normalizeQuestion(JSON.parse(line), index));
}

function normalizeQuestion(row: unknown, index: number): LongMemEvalQuestion {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`LongMemEval question ${index} is not an object`);
  }
  const record = row as Record<string, unknown>;
  const questionId = readString(record.question_id);
  const question = readString(record.question);
  const expected = readStringArray(record.expected_evidence_ids);
  if (!questionId) throw new Error(`LongMemEval question ${index} missing question_id`);
  if (!question) throw new Error(`LongMemEval question ${index} missing question`);
  if (expected.length === 0) {
    throw new Error(`LongMemEval question ${index} missing expected_evidence_ids`);
  }
  return {
    question_id: questionId,
    question,
    expected_evidence_ids: expected,
    category: readString(record.category) ?? "unknown",
    timestamp: readString(record.timestamp) ?? "",
  };
}

function normalizeK(k: number[] | undefined): number[] {
  const values = (k ?? DEFAULT_K)
    .map((value) => Math.floor(value))
    .filter((value) => value > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) return items;
  return items.slice(0, Math.max(0, Math.floor(limit)));
}

function withDefaultSearchConfig(
  searchConfig: RunLongMemEvalOptions["searchConfig"],
): Required<Pick<
  NonNullable<RunLongMemEvalOptions["searchConfig"]>,
  "embedClient" | "voyageClient"
>> & NonNullable<RunLongMemEvalOptions["searchConfig"]> {
  return {
    noRerank: true,
    embedClient: defaultEmbedClient(),
    voyageClient: defaultVoyageClient(),
    ...searchConfig,
  };
}

function defaultEmbedClient(): EmbedClient {
  return {
    async embed(texts) {
      return {
        vectors: texts.map(hashVector),
        model: "longmemeval-local-hash",
        dim: 16,
      };
    },
  };
}

function defaultVoyageClient(): VoyageClient {
  return {
    async embed(texts) {
      return {
        vectors: texts.map(hashVector),
        model: "longmemeval-local-hash",
        dim: 16,
      };
    },
    async rerank(_query, documents) {
      return {
        ranked: documents.map((document, index) => ({
          index,
          score: documents.length - index,
          document,
        })),
        model: "longmemeval-local-rerank",
      };
    },
  };
}

function hashVector(text: string): number[] {
  const vector = Array.from({ length: 16 }, () => 0);
  for (let index = 0; index < text.length; index += 1) {
    vector[index % vector.length]! += text.charCodeAt(index) / 255;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[index] ?? 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
