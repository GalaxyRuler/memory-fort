import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useGraph, type GraphScope } from "../../../src/dashboard-ui/hooks/useGraph.js";

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function GraphProbe({ scope }: { scope?: GraphScope }) {
  useGraph(scope);
  return null;
}

function graphResponse() {
  return {
    nodes: [],
    edges: [],
    unresolvedTargets: [],
  };
}

describe("useGraph", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetches /api/graph with scope param", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(graphResponse()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<GraphProbe scope="wiki" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/memory/api/graph");
    expect(String(fetchMock.mock.calls[0][0])).toContain("scope=wiki");
  });

  test("defaults scope to wiki", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(graphResponse()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<GraphProbe />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("scope=wiki");
  });
});
