import { fireEvent, render, screen, within } from "@testing-library/react";
import type { MouseEvent, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppShell } from "../../../src/dashboard-ui/layouts/AppShell.js";

const routerMockState = vi.hoisted(() => ({
  currentPath: "/wiki/projects/mobile-dashboard",
}));

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
    <a
      className={className}
      href={to}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        onClick?.();
      }}
    >
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

const originalMatchMedia = window.matchMedia;

function setMobileMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width") ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("mobile dashboard shell navigation", () => {
  beforeEach(() => {
    setMobileMedia(true);
    routerMockState.currentPath = "/wiki/projects/mobile-dashboard";
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  test("keeps the desktop sidebar hidden and renders mobile bottom navigation below md", () => {
    render(<AppShell />);

    const sidebar = screen.getByRole("complementary", { name: "Primary sidebar" });
    expect(sidebar).toHaveClass("hidden");
    expect(sidebar).toHaveClass("md:flex");
    expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toHaveClass("md:hidden");
  });

  test("collapses breadcrumbs to the deepest segment on mobile", () => {
    render(<AppShell />);

    expect(screen.getByTestId("mobile-breadcrumb")).toHaveTextContent("mobile-dashboard");
    expect(screen.getByTestId("desktop-breadcrumb")).toHaveClass("hidden");
  });

  test("opens the slide-over sidebar and closes it after navigation", () => {
    render(<AppShell />);

    fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));

    const dialog = screen.getByRole("dialog", { name: "Navigation menu" });
    expect(within(dialog).getByRole("link", { name: "Search" })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("link", { name: "Search" }));

    expect(screen.queryByRole("dialog", { name: "Navigation menu" })).not.toBeInTheDocument();
  });
});
