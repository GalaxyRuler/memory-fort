import { runSearch as runRetrievalSearch, type SearchResponse } from "../../../retrieval/search.js";
import { fail, pass, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

type SearchFn = () => Promise<Pick<SearchResponse, "query" | "results"> & {
  timings?: { totalMs?: number };
}>;

export interface SearchVerifyOptions extends VerifyCheckContext {
  searchFn?: SearchFn;
}

export const searchPipelineCheck: CheckDescriptor = {
  id: "search.pipeline",
  label: "search pipeline",
  roles: ["operator", "server"],
  run: checkSearch,
};

export async function checkSearch(
  opts: SearchVerifyOptions,
): Promise<VerifyCheckResult> {
  try {
    const result = await (opts.searchFn ?? (() => runDefaultSearch(opts.vaultRoot)))();
    const count = Array.isArray(result.results) ? result.results.length : 0;
    const totalMs = result.timings?.totalMs ?? 0;
    if (count === 0) {
      return fail(
        "search.pipeline",
        "search pipeline returned 0 results",
        "run `memory compile` and check the search index",
      );
    }
    return pass(
      "search.pipeline",
      `search pipeline returned ${count} results in ${totalMs}ms`,
    );
  } catch (error) {
    return fail(
      "search.pipeline",
      "search pipeline returns results",
      "run `memory compile` and check the search index",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function runDefaultSearch(vaultRoot: string): Promise<SearchResponse> {
  return runRetrievalSearch({
    query: "memory fort",
    scope: "all",
    k: 5,
    noRerank: true,
    noHyde: true,
    vaultRoot,
    embedClient: {
      async embed(texts) {
        return {
          vectors: texts.map(() => [1, 0, 0]),
          model: "memory-verify-local",
          dim: 3,
        };
      },
    },
    voyageClient: {
      async rerank(_query, documents) {
        return documents.map((_, index) => ({ index, relevanceScore: 1 }));
      },
    },
  });
}
