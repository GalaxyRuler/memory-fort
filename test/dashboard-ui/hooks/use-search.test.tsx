import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useSearch } from "../../../src/dashboard-ui/hooks/useSearch.js";

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function SearchProbe({ query }: { query: string }) {
  useSearch({ query });
  return null;
}

function makeSearchResponse() {
  return {
    query: "voyage",
    results: [],
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
});
