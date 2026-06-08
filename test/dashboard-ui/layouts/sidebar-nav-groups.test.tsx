import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Sidebar } from "../../../src/dashboard-ui/layouts/Sidebar.js";
import {
  ADVANCED_NAV_ITEMS,
  NAV_ITEMS,
  OPERATIONS_NAV_ITEMS,
  PRIMARY_NAV_ITEMS,
} from "../../../src/dashboard-ui/lib/nav-items.js";

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
      syncState: null,
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

describe("Sidebar navigation groups", () => {
  beforeEach(() => {
    routerMockState.currentPath = "/";
  });

  test("keeps the full route inventory split into primary, operations, and advanced groups", () => {
    expect(PRIMARY_NAV_ITEMS.map((item) => item.label)).toEqual([
      "Overview",
      "Search",
      "Wiki",
      "Graph",
      "Settings",
    ]);
    expect(OPERATIONS_NAV_ITEMS.map((item) => item.label)).toEqual([
      "Raw",
      "Timeline",
      "Activity",
      "Sessions",
      "Inbox",
      "Audit",
      "Compile",
      "Maintenance",
    ]);
    expect(ADVANCED_NAV_ITEMS.map((item) => item.label)).toEqual(["Crystals", "Conflict Resolution"]);
    expect(new Set([...PRIMARY_NAV_ITEMS, ...OPERATIONS_NAV_ITEMS, ...ADVANCED_NAV_ITEMS])).toEqual(
      new Set(NAV_ITEMS),
    );
  });

  test("shows primary links and collapses operations and advanced links by default", () => {
    render(<Sidebar />);

    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    for (const item of PRIMARY_NAV_ITEMS) {
      expect(within(nav).getByRole("link", { name: item.label })).toBeInTheDocument();
    }
    for (const item of OPERATIONS_NAV_ITEMS) {
      expect(within(nav).queryByRole("link", { name: item.label })).not.toBeInTheDocument();
    }
    for (const item of ADVANCED_NAV_ITEMS) {
      expect(within(nav).queryByRole("link", { name: item.label })).not.toBeInTheDocument();
    }

    expect(within(nav).getByRole("button", { name: "Operations" })).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "false");
  });

  test("reveals only operations links when the operations group is expanded", () => {
    render(<Sidebar />);

    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    fireEvent.click(within(nav).getByRole("button", { name: "Operations" }));

    expect(within(nav).getByRole("button", { name: "Operations" })).toHaveAttribute("aria-expanded", "true");
    for (const item of OPERATIONS_NAV_ITEMS) {
      expect(within(nav).getByRole("link", { name: item.label })).toBeInTheDocument();
    }
    expect(within(nav).queryByRole("link", { name: "Crystals" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Conflict Resolution" })).not.toBeInTheDocument();
  });

  test("reveals advanced links when the advanced group is expanded", () => {
    render(<Sidebar />);

    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    fireEvent.click(within(nav).getByRole("button", { name: "Advanced" }));

    expect(within(nav).getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
    for (const item of ADVANCED_NAV_ITEMS) {
      expect(within(nav).getByRole("link", { name: item.label })).toBeInTheDocument();
    }
  });

  test("opens advanced by default and highlights the active advanced route", () => {
    routerMockState.currentPath = "/conflicts/detail";

    render(<Sidebar />);

    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(within(nav).getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "true");
    expect(within(nav).getByRole("button", { name: "Operations" })).toHaveAttribute("aria-expanded", "false");

    const conflictsLink = within(nav).getByRole("link", { name: "Conflict Resolution" });
    expect(conflictsLink).toHaveClass("bg-surface-2");
    expect(conflictsLink.querySelector(".gradient-accent")).toBeInTheDocument();
  });
});
