import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Sidebar } from "../../../src/dashboard-ui/layouts/Sidebar.js";
import type { DashboardStatus } from "../../../src/dashboard-ui/hooks/useStatus.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    onClick,
    to,
  }: {
    children: ReactNode;
    className?: string;
    onClick?: () => void;
    to: string;
  }) => (
    <a className={className} href={to} onClick={onClick}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/" }),
}));

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function makeStatus(isStale: boolean): DashboardStatus {
  return {
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
      lastCheckoutAt: new Date(Date.now() - 8_000).toISOString(),
      isStale,
    },
    generatedAt: "2026-05-24T12:00:00.000Z",
  };
}

describe("Sidebar status pill", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders synced status from useStatus data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(makeStatus(false)), { status: 200 })),
    );

    renderWithQueryClient(<Sidebar />);

    const pill = await screen.findByText(/synced/);
    expect(pill).toHaveTextContent(/synced .*ago/);
    expect(pill.closest("span")).toHaveClass("text-status-green");
  });

  test("renders stale status from useStatus data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(makeStatus(true)), { status: 200 })),
    );

    renderWithQueryClient(<Sidebar />);

    const pill = await screen.findByText(/stale/);
    expect(pill).toHaveTextContent(/stale .*ago/);
    expect(pill.closest("span")).toHaveClass("text-status-amber");
  });

  test("renders a line skeleton while status is loading with no cached data", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    const { container } = renderWithQueryClient(<Sidebar />);

    expect(screen.queryByText(/synced/)).not.toBeInTheDocument();
    expect(container.querySelector('[data-variant="line"]')).toBeInTheDocument();
  });
});
