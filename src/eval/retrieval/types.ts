import type { SearchOptions, SearchResponse } from "../../retrieval/search.js";

export type RetrievalGoldType = "fact" | "causal" | "temporal" | "dependency" | "provenance";

export interface RetrievalGoldQuestion {
  query: string;
  expected_paths: string[];
  type: RetrievalGoldType;
}

export interface RetrievalQuestionResult {
  query: string;
  type: RetrievalGoldType;
  expected: string[];
  withGraph: {
    retrieved: string[];
    recall: Record<number, number>;
    reciprocalRank: number;
  };
  withoutGraph: {
    retrieved: string[];
    recall: Record<number, number>;
    reciprocalRank: number;
  };
  latencyMs: {
    withGraph: number;
    withoutGraph: number;
  };
}

export interface RetrievalAggregate {
  withGraph: number;
  withoutGraph: number;
}

export interface RetrievalEvalTypeBreakdown {
  questionCount: number;
  recall: Record<number, RetrievalAggregate>;
  graphLift: Record<number, number>;
  mrr: RetrievalAggregate;
}

export interface RetrievalEvalReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  vaultRoot: string;
  goldPath: string;
  questionCount: number;
  recall: Record<number, RetrievalAggregate>;
  graphLift: Record<number, number>;
  mrr: RetrievalAggregate;
  byType: Partial<Record<RetrievalGoldType, RetrievalEvalTypeBreakdown>>;
  perQuestion: RetrievalQuestionResult[];
}

export type RetrievalEvalSearch = (
  opts: SearchOptions,
) => Promise<SearchResponse>;
