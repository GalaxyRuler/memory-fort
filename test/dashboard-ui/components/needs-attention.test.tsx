import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NeedsAttention } from "../../../src/dashboard-ui/components/NeedsAttention.js";
import type { DashboardStatus } from "../../../src/dashboard-ui/hooks/useStatus.js";

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const routerMock = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => routerMock.navigate,
  };
});

function makeStatus(overrides: Partial<DashboardStatus> = {}): DashboardStatus {
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
      lastCheckoutAt: "2026-05-24T12:00:00.000Z",
      isStale: false,
    },
    generatedAt: "2026-05-24T12:00:00.000Z",
    ...overrides,
  };
}

describe("NeedsAttention actions", () => {
  beforeEach(() => {
    routerMock.navigate.mockReset();
  });

  test("Resolve navigates to conflicts", () => {
    renderWithQueryClient(
      <NeedsAttention
        status={makeStatus({
          syncState: {
            lastSyncAttempt: null,
            lastSyncSuccess: null,
            pendingPushCount: 0,
            conflictsPending: 1,
            conflictFiles: ["wiki/projects/a.md"],
            lastCheckoutAt: "2026-05-24T12:00:00.000Z",
            isStale: false,
          },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    expect(routerMock.navigate).toHaveBeenCalledWith({ to: "/conflicts" });
  });

  test("View navigates to audit errors", () => {
    renderWithQueryClient(
      <NeedsAttention
        status={makeStatus({
          errorsLog: { sizeBytes: 100, lastLine: "boom", isClean: false },
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(routerMock.navigate).toHaveBeenCalledWith({
      to: "/audit",
      search: { level: "error" },
    });
  });
});
