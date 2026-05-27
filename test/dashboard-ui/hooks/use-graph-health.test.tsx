import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useGraphHealth } from "../../../src/dashboard-ui/hooks/useGraphHealth.js";

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function GraphHealthProbe() {
  useGraphHealth();
  return null;
}

describe("useGraphHealth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetches /api/graph-health", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(report("pass")), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<GraphHealthProbe />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/memory/api/graph-health");
  });

  test("accepts a 503 response when it contains a fail report", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(report("fail")), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<GraphHealthProbe />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});

function report(overallStatus: "pass" | "warn" | "fail") {
  return {
    computedAt: "2026-05-27T00:00:00.000Z",
    overallStatus,
    metrics: [],
  };
}
