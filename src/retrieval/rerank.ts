import type { VoyageClient } from "./voyage-client.js";

export interface RerankCandidate {
  relPath: string;
  text: string;
}

export interface RerankInput {
  query: string;
  candidates: RerankCandidate[];
  voyageClient: VoyageClient;
  signal?: AbortSignal;
  topK?: number;
}

export interface RerankedItem {
  relPath: string;
  score: number;
  originalIndex: number;
}

export interface RerankResult {
  ranked: RerankedItem[];
  model: string;
  degraded: boolean;
  warning?: string;
  latencyMs: number;
}

export async function rerankCandidates(input: RerankInput): Promise<RerankResult> {
  if (input.candidates.length === 0) {
    return { ranked: [], model: "n/a", degraded: false, latencyMs: 0 };
  }

  const started = Date.now();
  try {
    const response = await input.voyageClient.rerank(
      input.query,
      input.candidates.map((candidate) => candidate.text),
      {
        topK: input.topK ?? input.candidates.length,
        signal: input.signal,
      },
    );
    return {
      ranked: response.ranked
        .map((item) => {
          const candidate = input.candidates[item.index];
          return {
            relPath: candidate?.relPath ?? "",
            score: item.score,
            originalIndex: item.index,
          };
        })
        .filter((item) => item.relPath.length > 0)
        .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex),
      model: response.model,
      degraded: false,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ranked: fallbackRanked(input.candidates),
      model: "n/a",
      degraded: true,
      warning: `voyage rerank failed: ${errorMessage(error)}; returning candidates in input order`,
      latencyMs: Date.now() - started,
    };
  }
}

function fallbackRanked(candidates: RerankCandidate[]): RerankedItem[] {
  return candidates.map((candidate, index) => ({
    relPath: candidate.relPath,
    score: 0,
    originalIndex: index,
  }));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}
