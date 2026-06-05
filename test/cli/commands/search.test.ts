import { describe, expect, it, vi } from "vitest";
import { runSearch } from "../../../src/cli/commands/search.js";

const responseFixture = {
  query: "voyage",
  results: [
    {
      path: "wiki/tools/voyageai.md",
      title: "voyageai npm SDK",
      snippet: "Official TypeScript SDK for Voyage AI embedding and rerank APIs.",
      score: 0.91,
      source: "rerank",
      sources: [{ source: "bm25", rank: 1 }],
      kind: "wiki",
    },
    {
      path: "wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md",
      title: "Voyage AI for embeddings and reranking",
      snippet: "Decision record for using Voyage AI in Phase 3 retrieval.",
      score: 0.88,
      source: "vector",
      sources: [{ source: "vector", rank: 1 }],
      kind: "wiki",
    },
  ],
  warnings: [],
  timings: { totalMs: 123 },
  degraded: false,
  hyde: { used: false, reason: "not-triggered" },
  corpusErrorCount: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const emptyConfigLoader = async () => ({});

describe("runSearch CLI command", () => {
  it("pretty-prints search results", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(responseFixture)) as unknown as typeof fetch;

    const result = await runSearch("voyage", { fetchFn, configLoader: emptyConfigLoader });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Query: voyage");
    expect(result.stdout).toContain("Found 2 results in 123ms");
    expect(result.stdout).toContain("wiki/tools/voyageai.md");
    expect(result.stdout).toContain("wiki/decisions/2026-05-20-voyage-ai-for-embeddings.md");
  });

  it("--json emits raw JSON", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(responseFixture)) as unknown as typeof fetch;

    const result = await runSearch("voyage", { fetchFn, configLoader: emptyConfigLoader, json: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(responseFixture);
  });

  it("returns exit 0 with a no-results message when the backend returns no matches", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ ...responseFixture, results: [] }),
    ) as unknown as typeof fetch;

    const result = await runSearch("nothing", { fetchFn, configLoader: emptyConfigLoader });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No results for query: nothing");
  });

  it("returns exit 3 when the search dashboard is offline", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await runSearch("voyage", { fetchFn, configLoader: emptyConfigLoader });

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Search dashboard offline");
    expect(result.stderr).toContain("--dashboard-url");
    expect(result.stderr).toContain("memory grep");
  });

  it("resolves dashboard URL with override before dashboard config before legacy vps config", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input) => {
      calls.push(String(input));
      return jsonResponse(responseFixture);
    }) as unknown as typeof fetch;
    const configLoader = async () => ({
      dashboard: { url: "https://mirror.example/memory/" },
      vps: { host: "old-vps.example" },
    });

    await runSearch("foo", { fetchFn, configLoader });
    await runSearch("foo", {
      fetchFn,
      configLoader,
      dashboardUrl: "https://override.example/memory",
    });

    expect(calls[0]).toMatch(/^https:\/\/mirror\.example\/memory\/api\/search\?/);
    expect(calls[1]).toMatch(/^https:\/\/override\.example\/memory\/api\/search\?/);
  });

  it("defaults to noRerank for bounded latency", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn(async (input) => {
      calls.push(String(input));
      return jsonResponse(responseFixture);
    }) as unknown as typeof fetch;

    await runSearch("operator preferences", { fetchFn, configLoader: emptyConfigLoader });

    expect(calls[0]).toContain("noRerank=true");
  });
});
