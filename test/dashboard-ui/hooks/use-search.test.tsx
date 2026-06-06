import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useSearch } from "../../../src/dashboard-ui/hooks/useSearch.js";

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function wrapperWithQueryClient({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function SearchProbe({ query }: { query: string }) {
  useSearch({ query });
  return null;
}

function makeSearchResponse(query = "voyage") {
  return {
    query,
    results: [
      {
        path: `wiki/projects/${query}.md`,
        title: `${query} result`,
        snippet: `${query} snippet`,
        score: 0.75,
        source: "bm25",
        sources: [{ source: "bm25", rank: 1 }],
        provenance: {
          path: `wiki/projects/${query}.md`,
          kind: "wiki",
          dominantSource: "bm25",
          signals: [{ source: "bm25", rank: 1 }],
        },
        kind: "wiki",
      },
    ],
    warnings: [],
    timings: {
      corpusMs: 1,
      embedQueryMs: 1,
      bm25Ms: 1,
      vectorMs: 1,
      rerankMs: 1,
      totalMs: 5,
    },
    degraded: false,
    hyde: { used: false, reason: "not-triggered" },
    corpusErrorCount: 0,
  };
}

describe("useSearch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("skips query when query is empty", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<SearchProbe query="" />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("fires query when query is non-empty", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(makeSearchResponse()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<SearchProbe query="voyage" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("q=voyage");
  });

  test("passes noRerank through to the search URL", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(makeSearchResponse()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderHook(
      () => useSearch({ query: "x", scope: "all", k: 12, noRerank: true }),
      { wrapper: wrapperWithQueryClient },
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("noRerank=true");
  });

  test("keeps previous data visible while a new query is pending", async () => {
    let releaseSecondRequest: ((response: Response) => void) | undefined;
    const secondRequest = new Promise<Response>((resolve) => {
      releaseSecondRequest = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeSearchResponse("first")), { status: 200 }),
      )
      .mockReturnValueOnce(secondRequest);
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ query }) => useSearch({ query, scope: "all", k: 12, noRerank: true }),
      {
        initialProps: { query: "first" },
        wrapper: wrapperWithQueryClient,
      },
    );

    await waitFor(() => {
      expect(result.current.data?.query).toBe("first");
    });

    rerender({ query: "second" });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(result.current.data?.query).toBe("first");

    releaseSecondRequest?.(
      new Response(JSON.stringify(makeSearchResponse("second")), { status: 200 }),
    );
    await waitFor(() => {
      expect(result.current.data?.query).toBe("second");
    });
  });

  test("normalizes malformed provenance signals at the API boundary", async () => {
    const response = makeSearchResponse();
    response.results[0] = {
      ...response.results[0],
      sources: [
        { source: "bm25", rank: 1 },
        { source: "", rank: 2 },
        { source: "vector", rank: 0 },
        { source: "rerank", rank: 3 },
      ],
      provenance: {
        ...response.results[0].provenance,
        signals: [
          { source: "bm25", rank: 1 },
          { source: "", rank: 2 },
          { source: "vector", rank: 0 },
          { source: "rerank", rank: "3" },
        ] as unknown as Array<{ source: string; rank: number }>,
      },
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(response), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(
      () => useSearch({ query: "voyage", scope: "all", k: 12, noRerank: true }),
      { wrapper: wrapperWithQueryClient },
    );

    await waitFor(() => {
      expect(result.current.data?.results[0]?.provenance.signals).toEqual([
        { source: "bm25", rank: 1 },
        { source: "rerank", rank: 3 },
      ]);
    });
    expect(result.current.data?.results[0]?.sources).toEqual([
      { source: "bm25", rank: 1 },
      { source: "rerank", rank: 3 },
    ]);
  });

  test("normalizes omitted provenance at the API boundary", async () => {
    const response = makeSearchResponse();
    const resultWithoutProvenance = { ...response.results[0] } as Record<string, unknown>;
    delete resultWithoutProvenance.provenance;
    response.results[0] = resultWithoutProvenance as unknown as (typeof response.results)[number];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(response), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(
      () => useSearch({ query: "voyage", scope: "all", k: 12, noRerank: true }),
      { wrapper: wrapperWithQueryClient },
    );

    await waitFor(() => {
      expect(result.current.data?.results[0]?.provenance).toEqual({
        path: "wiki/projects/voyage.md",
        kind: "wiki",
        dominantSource: "bm25",
        signals: [],
      });
    });
  });

  test("normalizes empty provenance at the API boundary", async () => {
    const response = makeSearchResponse();
    response.results[0] = {
      ...response.results[0],
      provenance: {},
    } as unknown as (typeof response.results)[number];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(response), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(
      () => useSearch({ query: "voyage", scope: "all", k: 12, noRerank: true }),
      { wrapper: wrapperWithQueryClient },
    );

    await waitFor(() => {
      expect(result.current.data?.results[0]?.provenance).toEqual({
        path: "wiki/projects/voyage.md",
        kind: "wiki",
        dominantSource: "bm25",
        signals: [],
      });
    });
  });

  test("drops invalid top-level results and defaults malformed fields", async () => {
    const response = makeSearchResponse();
    response.results = [
      {
        path: 42,
        title: "Dropped",
        snippet: "Missing string path",
        score: 1,
        source: "bm25",
        kind: "wiki",
      },
      {
        path: "wiki/projects/dropped.md",
        title: "Dropped",
        snippet: "Invalid kind",
        score: 1,
        source: "bm25",
        kind: "unknown",
      },
      {
        path: "wiki/projects/kept.md",
        title: null,
        snippet: 99,
        score: Number.POSITIVE_INFINITY,
        source: { label: "bm25" },
        sources: [{ source: "bm25", rank: 1 }],
        kind: "wiki",
        provenance: {
          path: "wiki/projects/kept.md",
          kind: "wiki",
          dominantSource: 123,
          signals: [{ source: "rerank", rank: "2" }],
        },
      },
    ] as unknown as typeof response.results;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify(response), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(
      () => useSearch({ query: "voyage", scope: "all", k: 12, noRerank: true }),
      { wrapper: wrapperWithQueryClient },
    );

    await waitFor(() => {
      expect(result.current.data?.results).toHaveLength(1);
    });
    expect(result.current.data?.results[0]).toMatchObject({
      path: "wiki/projects/kept.md",
      title: "",
      snippet: "",
      score: 0,
      source: "",
      kind: "wiki",
      provenance: {
        path: "wiki/projects/kept.md",
        kind: "wiki",
        dominantSource: "",
        signals: [{ source: "rerank", rank: 2 }],
      },
    });
  });
});
