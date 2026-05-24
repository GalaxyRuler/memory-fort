import { render, screen, within } from "@testing-library/react";
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

describe("dashboard app shell", () => {
  beforeEach(() => {
    routerMockState.currentPath = "/";
  });

  test("AppShell renders sidebar and main content area", () => {
    render(<AppShell />);

    expect(screen.getByRole("complementary")).toHaveTextContent("memory");
    expect(screen.getByTestId("route-outlet")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /mobile navigation/i })).toBeInTheDocument();
  });

  test("Sidebar lists all 11 nav items", () => {
    render(<Sidebar />);

    const sidebar = screen.getByRole("complementary");
    expect(within(sidebar).getAllByRole("link")).toHaveLength(11);
    for (const item of NAV_ITEMS) {
      expect(within(sidebar).getByRole("link", { name: item.label })).toBeInTheDocument();
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
    routerMockState.currentPath = "/activity";

    render(<MobileBottomNav />);

    expect(screen.getByRole("link", { name: "Activity" })).toHaveClass("text-text-primary");
  });
});
