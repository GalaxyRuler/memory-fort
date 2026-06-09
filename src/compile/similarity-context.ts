import { findSimilar, type EmbeddingRecord, type SimilarResult } from "../retrieval/embeddings-store.js";

export interface SelectSimilarContextInput {
  queryVector: number[];
  embeddingRecords: EmbeddingRecord[];
  threshold: number;
  topK: number;
}

export async function selectSimilarContext(
  input: SelectSimilarContextInput,
): Promise<SimilarResult[]> {
  return findSimilar(input.queryVector, input.embeddingRecords, {
    threshold: input.threshold,
    topK: input.topK,
  });
}
