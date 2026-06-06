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
      async () => new Response(JSON.stringify(makeSearchResponse()), { status: 200 }),
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
      async () => new Response(JSON.stringify(makeSearchResponse()), { status: 200 }),
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
});
