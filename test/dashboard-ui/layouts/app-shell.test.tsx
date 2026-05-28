import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AppShell } from "../../../src/dashboard-ui/layouts/AppShell.js";
import { MobileBottomNav } from "../../../src/dashboard-ui/layouts/MobileBottomNav.js";
import { Sidebar } from "../../../src/dashboard-ui/layouts/Sidebar.js";
import { TopBar } from "../../../src/dashboard-ui/layouts/TopBar.js";
import { MOBILE_NAV_ITEMS, NAV_ITEMS } from "../../../src/dashboard-ui/lib/nav-items.js";

const routerMockState = vi.hoisted(() => ({ currentPath: "/" }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    to,
  }: {
    children: ReactNode;
    className?: string;
    to: string;
  }) => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
  Outlet: () => <div data-testid="route-outlet">Route content</div>,
  useLocation: () => ({ pathname: routerMockState.currentPath }),
}));

vi.mock("../../../src/dashboard-ui/hooks/useStatus.js", () => ({
  useStatus: () => ({
    data: {
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
    },
    isError: false,
    isLoading: false,
  }),
}));

vi.mock("../../../src/dashboard-ui/hooks/useSyncState.js", () => ({
  useSyncState: () => ({
    data: {
      lastCheckoutAt: "2026-05-24T12:00:00.000Z",
      lastCommit: "60d9f22",
      status: "synced",
    },
    isError: false,
    isLoading: false,
  }),
}));

describe("dashboard app shell", () => {
  beforeEach(() => {
    routerMockState.currentPath = "/";
  });

  test("AppShell renders sidebar and main content area", () => {
    render(<AppShell />);

    expect(screen.getByRole("complementary")).toHaveTextContent("Memory Fort");
    expect(screen.getByTestId("route-outlet")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /mobile navigation/i })).toBeInTheDocument();
  });

  test("Sidebar lists all nav items", () => {
    render(<Sidebar />);

    const sidebar = screen.getByRole("complementary");
    const nav = within(sidebar).getByRole("navigation", { name: "Primary navigation" });
    expect(within(nav).getAllByRole("link")).toHaveLength(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) {
      expect(within(nav).getByRole("link", { name: item.label })).toBeInTheDocument();
    }
  });

  test("Sidebar highlights the active route", () => {
    routerMockState.currentPath = "/wiki";

    render(<Sidebar />);

    const wikiLink = screen.getByRole("link", { name: "Wiki" });
    expect(wikiLink).toHaveClass("bg-surface-2");
    expect(wikiLink.querySelector(".gradient-accent")).toBeInTheDocument();
  });

  test("TopBar shows a breadcrumb matching the current route", () => {
    routerMockState.currentPath = "/wiki";

    render(<TopBar />);

    expect(screen.getByText("Wiki")).toBeInTheDocument();
  });

  test("TopBar command palette trigger is present", () => {
    render(<TopBar />);

    const button = screen.getByRole("button", { name: "Open command palette" });
    expect(button).toHaveTextContent("Search");
    expect(within(button).getByText("⌘K")).toBeInTheDocument();
  });

  test("MobileBottomNav lists exactly 5 nav items", () => {
    render(<MobileBottomNav />);

    expect(screen.getAllByRole("link")).toHaveLength(5);
    for (const item of MOBILE_NAV_ITEMS) {
      expect(screen.getByRole("link", { name: item.label })).toBeInTheDocument();
    }
  });

  test("MobileBottomNav highlights the active item", () => {
    routerMockState.currentPath = "/timeline";

    render(<MobileBottomNav />);

    expect(screen.getByRole("link", { name: "Timeline" })).toHaveClass("text-text-primary");
  });

  test("mobile drawer backdrop is hidden from assistive tech and closes the drawer", async () => {
    render(<AppShell />);

    fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));

    expect(screen.getAllByRole("button", { name: "Close navigation menu" })).toHaveLength(1);
    const backdrop = screen.getByTestId("mobile-drawer-backdrop");
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    expect(backdrop).not.toHaveAttribute("aria-label");

    fireEvent.click(backdrop);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Navigation menu" })).not.toBeInTheDocument();
    });
  });
});
