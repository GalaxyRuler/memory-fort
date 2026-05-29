import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Sidebar } from "../../../src/dashboard-ui/layouts/Sidebar.js";
import { useSyncState } from "../../../src/dashboard-ui/hooks/useSyncState.js";
import { useStatus } from "../../../src/dashboard-ui/hooks/useStatus.js";
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

vi.mock("../../../src/dashboard-ui/hooks/useStatus.js", () => ({
  useStatus: vi.fn(),
}));

vi.mock("../../../src/dashboard-ui/hooks/useSyncState.js", () => ({
  useSyncState: vi.fn(),
}));

const mockUseStatus = vi.mocked(useStatus);
const mockUseSyncState = vi.mocked(useSyncState);

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function makeStatusWithoutSidecar(): DashboardStatus {
  return {
    vaultRoot: "C:/memory",
    repoHead: null,
    counts: { wikiPages: 13, rawObservations: 40, crystals: 0 },
    lastCompile: null,
    errorsLog: { sizeBytes: 0, lastLine: null, isClean: true },
    syncState: null,
    generatedAt: "2026-05-24T12:00:00.000Z",
  };
}

describe("Sidebar status pill", () => {
  beforeEach(() => {
    mockUseStatus.mockReturnValue(cleanStatusQuery());
    mockUseSyncState.mockReturnValue(syncStateQuery({
      status: "unknown",
      lastCheckoutAt: null,
      lastCommit: null,
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("renders synced status from checkout sync-state data", () => {
    mockUseSyncState.mockReturnValue(syncStateQuery({
      status: "synced",
      lastCheckoutAt: new Date(Date.now() - 8_000).toISOString(),
      lastCommit: "60d9f22",
    }));

    renderWithQueryClient(<Sidebar />);

    const pill = screen.getByText(/synced/);
    expect(pill).toHaveTextContent(/synced .*ago/);
    expect(pill.closest("span")).toHaveClass("text-status-green");
    expect(pill.closest("a")).toHaveAttribute("href", "/memory/");
  });

  test("demotes the brand heading so pages keep a single h1", () => {
    renderWithQueryClient(<Sidebar />);

    expect(screen.queryByRole("heading", { name: "Memory Fort", level: 1 })).not.toBeInTheDocument();
    expect(screen.getByText("Memory Fort")).toBeInTheDocument();
  });

  test("renders stale status from checkout sync-state data", () => {
    mockUseSyncState.mockReturnValue(syncStateQuery({
      status: "stale",
      lastCheckoutAt: new Date(Date.now() - 8_000).toISOString(),
      lastCommit: "60d9f22",
    }));

    renderWithQueryClient(<Sidebar />);

    const pill = screen.getByText(/stale/);
    expect(pill).toHaveTextContent(/stale .*ago/);
    expect(pill.closest("span")).toHaveClass("text-status-amber");
  });

  test("renders unknown when checkout sync-state data errors", () => {
    mockUseSyncState.mockReturnValue(syncStateQuery(undefined, { isError: true }));

    renderWithQueryClient(<Sidebar />);

    const pill = screen.getByText("unknown");
    expect(pill.closest("span")).toHaveClass("text-text-muted");
  });

  test("renders a line skeleton while status is loading with no cached data", () => {
    mockUseStatus.mockReturnValue(statusQuery(undefined, { isLoading: true }));
    mockUseSyncState.mockReturnValue(syncStateQuery(undefined, { isLoading: true }));

    const { container } = renderWithQueryClient(<Sidebar />);

    expect(screen.queryByText(/synced/)).not.toBeInTheDocument();
    expect(container.querySelector('[data-variant="line"]')).toBeInTheDocument();
  });

  test("links recent error state to filtered audit entries", () => {
    // Relative-recent timestamp so the test is deterministic regardless of
    // wall-clock: the component's hasRecentErrorLog compares against Date.now()
    // with a 24h window, so a hardcoded date eventually ages out of "recent".
    const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockUseStatus.mockReturnValue(statusQuery({
      ...makeStatusWithoutSidecar(),
      errorsLog: {
        sizeBytes: 120,
        lastLine: `${recentIso} fatal compile error`,
        isClean: false,
      },
    }));

    renderWithQueryClient(<Sidebar />);

    const link = screen.getByRole("link", { name: /error/i });
    expect(link).toHaveAttribute("href", "/memory/audit?level=error&source=errors");
    expect(link).toHaveAttribute("aria-label", expect.stringMatching(/View recent errors/i));
    expect(link).toHaveAttribute("title", expect.stringMatching(/View recent errors/i));
  });

  test("renders stale error logs as healthy when no recent error line exists", () => {
    mockUseStatus.mockReturnValue(statusQuery({
      ...makeStatusWithoutSidecar(),
      errorsLog: {
        sizeBytes: 120,
        lastLine: "2026-05-24T10:00:00.000Z old compile error",
        isClean: false,
      },
    }));
    mockUseSyncState.mockReturnValue(syncStateQuery({
      status: "synced",
      lastCheckoutAt: new Date(Date.now() - 8_000).toISOString(),
      lastCommit: "60d9f22",
    }));

    renderWithQueryClient(<Sidebar />);

    const pill = screen.getByText("healthy");
    expect(pill.closest("span")).toHaveClass("text-status-green");
    expect(screen.queryByText(/error/)).not.toBeInTheDocument();
  });
});

function cleanStatusQuery(): ReturnType<typeof useStatus> {
  return statusQuery(makeStatusWithoutSidecar());
}

function statusQuery(
  data: DashboardStatus | undefined,
  opts: { isLoading?: boolean; isError?: boolean } = {},
): ReturnType<typeof useStatus> {
  return {
    data,
    isLoading: opts.isLoading ?? false,
    isError: opts.isError ?? false,
  } as ReturnType<typeof useStatus>;
}

function syncStateQuery(
  data: ReturnType<typeof useSyncState>["data"],
  opts: { isLoading?: boolean; isError?: boolean } = {},
): ReturnType<typeof useSyncState> {
  return {
    data,
    isLoading: opts.isLoading ?? false,
    isError: opts.isError ?? false,
  } as ReturnType<typeof useSyncState>;
}
