import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useActivity } from "../../../src/dashboard-ui/hooks/useActivity.js";

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function ActivityProbe() {
  useActivity(50);
  return null;
}

describe("useActivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("passes limit to URL", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ events: [], nextCursor: null }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<ActivityProbe />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=50");
  });
});
