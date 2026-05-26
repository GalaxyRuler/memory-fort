import type { SearchOptions } from "../../retrieval/search.js";

export interface LongMemEvalQuestion {
  question_id: string;
  question: string;
  expected_evidence_ids: string[];
  category: string;
  timestamp: string;
}

export type SearchConfig = Partial<
  Omit<SearchOptions, "query" | "scope" | "k" | "vaultRoot">
>;

export interface RunLongMemEvalOptions {
  datasetPath: string;
  vaultRoot: string;
  k?: number[];
  limit?: number;
  searchConfig?: SearchConfig;
}

export interface LongMemEvalReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  vaultRoot: string;
  datasetVersion: string;
  questionCount: number;
  recall: Record<number, number>;
  meanLatencyMs: number;
  p95LatencyMs: number;
  perQuestion: Array<{
    questionId: string;
    question: string;
    expected: string[];
    retrieved: string[];
    hits: Record<number, boolean>;
    latencyMs: number;
  }>;
}
