import { readFile } from "node:fs/promises";
import { normalizeEvidenceId } from "../longmemeval/scoring.js";
import { runSearch } from "../../retrieval/search.js";
import { loadSearchCorpus } from "../../retrieval/corpus.js";
import type { EmbedClient } from "../../retrieval/refresh.js";
import type { VoyageClient } from "../../retrieval/voyage-client.js";
import type {
  RetrievalEvalReport,
  RetrievalEvalSearch,
  RetrievalEvalTypeBreakdown,
  RetrievalGoldQuestion,
  RetrievalGoldType,
  RetrievalQuestionResult,
} from "./types.js";

const DEFAULT_K = [5, 10];
const GOLD_TYPES = new Set<RetrievalGoldType>([
  "fact",
  "causal",
  "temporal",
  "dependency",
  "provenance",
]);

export interface RunRetrievalEvalOptions {
  goldPath: string;
  vaultRoot: string;
  k?: number[];
  limit?: number;
  search?: RetrievalEvalSearch;
}

export async function runRetrievalEval(
  opts: RunRetrievalEvalOptions,
): Promise<RetrievalEvalReport> {
  const startedAtDate = new Date();
  const startedMs = Date.now();
  const kValues = normalizeK(opts.k);
  const maxK = Math.max(...kValues);
  const questions = applyLimit(await loadRetrievalGold(opts.goldPath), opts.limit);
  const search = opts.search ?? runSearch;
  const corpus = opts.search
    ? null
    : await loadSearchCorpus({ vaultRoot: opts.vaultRoot, scope: "all" });
  const searchConfig = {
    noHyde: true,
    noRerank: true,
    embedClient: defaultEmbedClient(),
    voyageClient: defaultVoyageClient(),
    refreshEmbeddings: false,
    ...(corpus ? { corpusLoader: async () => corpus } : {}),
  };

  const perQuestion: RetrievalQuestionResult[] = [];
  for (const question of questions) {
    const withGraph = await search({
      ...searchConfig,
      query: question.query,
      scope: "all",
      k: maxK,
      vaultRoot: opts.vaultRoot,
      graphSpread: true,
    });
    const withoutGraph = await search({
      ...searchConfig,
      query: question.query,
      scope: "all",
      k: maxK,
      vaultRoot: opts.vaultRoot,
      graphSpread: false,
    });

    const withPaths = withGraph.results.map((result) => result.path);
    const withoutPaths = withoutGraph.results.map((result) => result.path);
    perQuestion.push({
      query: question.query,
      type: question.type,
      expected: question.expected_paths,
      withGraph: {
        retrieved: withPaths,
        recall: recallMap(question.expected_paths, withPaths, kValues),
        reciprocalRank: reciprocalRank(question.expected_paths, withPaths),
      },
      withoutGraph: {
        retrieved: withoutPaths,
        recall: recallMap(question.expected_paths, withoutPaths, kValues),
        reciprocalRank: reciprocalRank(question.expected_paths, withoutPaths),
      },
      latencyMs: {
        withGraph: withGraph.timings.totalMs,
        withoutGraph: withoutGraph.timings.totalMs,
      },
    });
  }

  const finishedAtDate = new Date();
  const aggregate = aggregateQuestions(perQuestion, kValues);
  return {
    startedAt: startedAtDate.toISOString(),
    finishedAt: finishedAtDate.toISOString(),
    durationMs: Math.max(0, Date.now() - startedMs),
    vaultRoot: opts.vaultRoot,
    goldPath: opts.goldPath,
    questionCount: perQuestion.length,
    recall: aggregate.recall,
    graphLift: aggregate.graphLift,
    mrr: aggregate.mrr,
    byType: aggregateByType(perQuestion, kValues),
    perQuestion,
  };
}

export async function loadRetrievalGold(path: string): Promise<RetrievalGoldQuestion[]> {
  const text = await readFile(path, "utf-8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => normalizeQuestion(JSON.parse(line), index));
}

function normalizeQuestion(row: unknown, index: number): RetrievalGoldQuestion {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`retrieval gold row ${index} is not an object`);
  }
  const record = row as Record<string, unknown>;
  const query = readString(record["query"]);
  const expected = readStringArray(record["expected_paths"]);
  const type = readString(record["type"]);
  if (!query) throw new Error(`retrieval gold row ${index} missing query`);
  if (expected.length === 0) throw new Error(`retrieval gold row ${index} missing expected_paths`);
  if (!type || !GOLD_TYPES.has(type as RetrievalGoldType)) {
    throw new Error(`retrieval gold row ${index} type must be one of: ${[...GOLD_TYPES].join(", ")}`);
  }
  return { query, expected_paths: expected, type: type as RetrievalGoldType };
}

function aggregateByType(
  questions: RetrievalQuestionResult[],
  kValues: number[],
): RetrievalEvalReport["byType"] {
  const byType: Partial<Record<RetrievalGoldType, RetrievalEvalTypeBreakdown>> = {};
  for (const type of GOLD_TYPES) {
    const subset = questions.filter((question) => question.type === type);
    if (subset.length === 0) continue;
    const aggregate = aggregateQuestions(subset, kValues);
    byType[type] = {
      questionCount: subset.length,
      ...aggregate,
    };
  }
  return byType;
}

function aggregateQuestions(
  questions: RetrievalQuestionResult[],
  kValues: number[],
): Pick<RetrievalEvalReport, "recall" | "graphLift" | "mrr"> {
  const recall = Object.fromEntries(
    kValues.map((k) => {
      const withGraph = mean(questions.map((question) => question.withGraph.recall[k] ?? 0));
      const withoutGraph = mean(questions.map((question) => question.withoutGraph.recall[k] ?? 0));
      return [k, { withGraph, withoutGraph }];
    }),
  ) as RetrievalEvalReport["recall"];
  const graphLift = Object.fromEntries(
    kValues.map((k) => [k, round((recall[k]?.withGraph ?? 0) - (recall[k]?.withoutGraph ?? 0), 4)]),
  ) as RetrievalEvalReport["graphLift"];
  return {
    recall,
    graphLift,
    mrr: {
      withGraph: mean(questions.map((question) => question.withGraph.reciprocalRank)),
      withoutGraph: mean(questions.map((question) => question.withoutGraph.reciprocalRank)),
    },
  };
}

function recallMap(expected: string[], retrieved: string[], kValues: number[]): Record<number, number> {
  return Object.fromEntries(kValues.map((k) => [k, recallAtK(expected, retrieved, k)]));
}

function recallAtK(expected: string[], retrieved: string[], k: number): number {
  const expectedSet = new Set(expected.map(normalizeEvidenceId));
  if (expectedSet.size === 0) return 0;
  const hits = new Set(
    retrieved
      .slice(0, k)
      .map(normalizeEvidenceId)
      .filter((path) => expectedSet.has(path)),
  );
  return hits.size / expectedSet.size;
}

function reciprocalRank(expected: string[], retrieved: string[]): number {
  const expectedSet = new Set(expected.map(normalizeEvidenceId));
  const index = retrieved.map(normalizeEvidenceId).findIndex((path) => expectedSet.has(path));
  return index < 0 ? 0 : 1 / (index + 1);
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

function defaultEmbedClient(): EmbedClient {
  return {
    async embed(texts: string[]) {
      return {
        vectors: texts.map(() => []),
        model: "retrieval-eval-no-vector",
        dim: 0,
      };
    },
  };
}

function defaultVoyageClient(): VoyageClient {
  return {
    async embed(texts) {
      return {
        vectors: texts.map(hashVector),
        model: "retrieval-eval-local-hash",
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
        model: "retrieval-eval-local-rerank",
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
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 4);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}
