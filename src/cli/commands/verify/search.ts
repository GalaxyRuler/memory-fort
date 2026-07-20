import { runSearch as runRetrievalSearch, type SearchResponse } from "../../../retrieval/search.js";
import type { MemoryConfig } from "../../../storage/config.js";
import { resolveDashboardUrl } from "./dashboard.js";
import { fail, pass, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

type SearchFn = () => Promise<Pick<SearchResponse, "query" | "results"> & {
  timings?: { totalMs?: number };
}>;

export interface SearchVerifyOptions extends VerifyCheckContext {
  searchFn?: SearchFn;
  fetchFn?: typeof fetch;
  configLoader?: () => Promise<Pick<MemoryConfig, "dashboard" | "vps">>;
}

export const searchPipelineCheck: CheckDescriptor = {
  id: "search.pipeline",
  label: "search pipeline",
  roles: ["operator", "server"],
  timeoutMs: 120_000,
  run: checkSearch,
};

export async function checkSearch(
  opts: SearchVerifyOptions,
): Promise<VerifyCheckResult> {
  try {
    const result = await (opts.searchFn ?? (() => runDefaultSearch(opts)))();
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

// Prefer the dashboard's bounded index search: the in-process legacy pipeline
// loads the entire corpus and OOMs the CLI at the default Node heap on a
// multi-GB vault. Falls back to the legacy pipeline when the dashboard is
// unreachable or returns nothing (e.g. its index is still building).
async function runDefaultSearch(
  opts: SearchVerifyOptions,
): Promise<Pick<SearchResponse, "query" | "results"> & { timings?: { totalMs?: number } }> {
  if (!opts.offline) {
    try {
      const baseUrl = await resolveDashboardUrl(opts.dashboardUrl, opts.configLoader);
      const response = await (opts.fetchFn ?? fetch)(
        `${baseUrl}/api/search?q=${encodeURIComponent("memory fort")}&k=5`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (response.ok) {
        const body = (await response.json()) as {
          query?: string;
          results?: unknown[];
          timings?: { totalMs?: number };
        };
        if (Array.isArray(body.results) && body.results.length > 0) {
          return {
            query: body.query ?? "memory fort",
            results: body.results as SearchResponse["results"],
            timings: body.timings,
          };
        }
      }
    } catch {
      // Dashboard offline — fall through to the local pipeline.
    }
  }
  return runLocalSearch(opts.vaultRoot);
}

async function runLocalSearch(vaultRoot: string): Promise<SearchResponse> {
  return runRetrievalSearch({
    query: "memory fort",
    // wiki scope: the local pipeline retains bodies, and an all-scope load on
    // a multi-GB raw pool is exactly the OOM this check's dashboard-first path
    // exists to avoid. Verifying the pipeline against the (small) curated wiki
    // corpus answers the same question — "does search return results" —
    // without the fallback being able to kill the process (`--offline`, a
    // starting dashboard, or an empty index all land here).
    scope: "wiki",
    k: 5,
    noRerank: true,
    noHyde: true,
    vaultRoot,
    embedClient: {
      async embed(texts: string[]) {
        return {
          vectors: texts.map(() => [1, 0, 0]),
          model: "memory-verify-local",
          dim: 3,
        };
      },
    },
    voyageClient: {
      async embed(texts: string[]) {
        return {
          vectors: texts.map(() => [1, 0, 0]),
          model: "memory-verify-local",
          dim: 3,
        };
      },
      async rerank(_query, documents) {
        return {
          ranked: documents.map((document, index) => ({
            index,
            score: 1,
            document,
          })),
          model: "memory-verify-local-rerank",
        };
      },
    },
  });
}
