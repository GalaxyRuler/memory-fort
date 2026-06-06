import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useStatus } from "../../../src/dashboard-ui/hooks/useStatus.js";
import type { DashboardStatus } from "../../../src/dashboard-ui/hooks/useStatus.js";

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function StatusProbe() {
  const status = useStatus();
  if (status.isLoading) return <p>loading</p>;
  if (status.isError) return <p>error</p>;
  return <p>wiki pages: {status.data.counts.wikiPages}</p>;
}

describe("useStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("returns data from mocked fetch", async () => {
    const status: DashboardStatus = {
      vaultRoot: "C:/memory",
      repoHead: {
        sha: "abcdef123",
        shortSha: "abcdef1",
        subject: "test commit",
        committedAt: "2026-05-24T00:00:00Z",
      },
      counts: { wikiPages: 42, rawObservations: 7, crystals: 1 },
      lastCompile: null,
      errorsLog: { sizeBytes: 0, lastLine: null, isClean: true },
      syncState: null,
      generatedAt: "2026-05-24T00:00:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })),
    );

    renderWithQueryClient(<StatusProbe />);

    await waitFor(() => {
      expect(screen.getByText("wiki pages: 42")).toBeInTheDocument();
    });
  });
});
