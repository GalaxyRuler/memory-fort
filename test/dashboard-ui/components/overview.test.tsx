import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { NeedsAttention } from "../../../src/dashboard-ui/components/NeedsAttention.js";
import { RecentActivity } from "../../../src/dashboard-ui/components/RecentActivity.js";
import { Sparkline } from "../../../src/dashboard-ui/components/Sparkline.js";
import { StatCard } from "../../../src/dashboard-ui/components/StatCard.js";
import type { ActivityEvent } from "../../../src/dashboard-ui/hooks/useActivity.js";
import type { DashboardStatus } from "../../../src/dashboard-ui/hooks/useStatus.js";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("overview components", () => {
  test("Sparkline renders polyline with correct point count", () => {
    const { container } = render(<Sparkline data={[1, 3, 2, 5, 4]} />);

    const polyline = container.querySelector("polyline");
    expect(polyline).toBeInTheDocument();
    expect(polyline?.getAttribute("points")?.split(" ")).toHaveLength(5);
  });

  test("StatCard renders label, value, and footer", () => {
    render(<StatCard label="Test" value="42" footer="ok" />);

    expect(screen.getByText("Test")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  test("RecentActivity renders loading state", () => {
    render(<RecentActivity events={undefined} isLoading={true} />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  test("RecentActivity renders events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-24T12:00:30Z"));
    const events: ActivityEvent[] = [
      {
        timestamp: "2026-05-24T12:00:00Z",
        source: "git",
        level: "info",
        summary: "commit landed",
      },
      {
        timestamp: "2026-05-24T11:58:00Z",
        source: "sync",
        level: "info",
        summary: "sync completed",
      },
    ];

    render(<RecentActivity events={events} isLoading={false} />);

    expect(screen.getByText("commit landed")).toBeInTheDocument();
    expect(screen.getByText("sync completed")).toBeInTheDocument();
    expect(screen.getAllByText(/ago$/).length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  test("NeedsAttention shows All clear when status is clean", () => {
    const status: DashboardStatus = {
      vaultRoot: "C:/memory",
      repoHead: null,
      counts: { wikiPages: 13, rawObservations: 40, crystals: 0 },
      lastCompile: null,
      errorsLog: { sizeBytes: 0, lastLine: null, isClean: true },
      syncState: {
        lastSyncAttempt: null,
        lastSyncSuccess: null,
        pendingPushCount: 0,
        conflictsPending: 0,
        conflictFiles: [],
      },
      generatedAt: "2026-05-24T12:00:00Z",
    };

    renderWithQueryClient(<NeedsAttention status={status} />);

    expect(screen.getByText("All clear")).toBeInTheDocument();
  });
});
