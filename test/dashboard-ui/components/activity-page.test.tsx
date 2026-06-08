import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ActivityEventRow } from "../../../src/dashboard-ui/components/ActivityEventRow.js";
import { ActivityFeedPage } from "../../../src/dashboard-ui/components/ActivityFeedPage.js";
import { ActivityFilters } from "../../../src/dashboard-ui/components/ActivityFilters.js";
import type { ActivityEvent } from "../../../src/dashboard-ui/hooks/useActivity.js";

const routerState = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));

const activityHook = vi.hoisted(() => ({
  useActivity: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => routerState.navigate,
  useSearch: () => routerState.search,
}));

vi.mock("../../../src/dashboard-ui/hooks/useActivity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useActivity.js")>();
  return {
    ...actual,
    useActivity: activityHook.useActivity,
  };
});

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    timestamp: "2026-05-24T12:00:00.000Z",
    source: "git",
    level: "info",
    summary: "ffd7137 raw browse shipped",
    ...overrides,
  };
}

describe("activity page components", () => {
  test("ActivityEventRow renders source icon, summary, and relative time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-24T12:02:00.000Z"));

    render(<ActivityEventRow event={event()} />);

    expect(screen.getByText("ffd7137 raw browse shipped")).toBeInTheDocument();
    expect(screen.getByText("2m ago")).toBeInTheDocument();
    expect(screen.getByText("git")).toBeInTheDocument();

    vi.useRealTimers();
  });

  test("ActivityEventRow uses the correct color class for each source", () => {
    const { container, rerender } = render(<ActivityEventRow event={event({ source: "git" })} />);
    expect(container.querySelector(".text-status-blue")).not.toBeNull();

    rerender(<ActivityEventRow event={event({ source: "errors", level: "error" })} />);
    expect(container.querySelector(".text-status-red")).not.toBeNull();
  });

  test("ActivityFilters fires onChange when source changes", () => {
    const onChange = vi.fn();

    render(<ActivityFilters level="all" onChange={onChange} source="all" />);
    fireEvent.click(screen.getByRole("button", { name: "Compile" }));

    expect(onChange).toHaveBeenCalledWith({ source: "compile" });
  });

  test("ActivityFilters fires onChange when level changes", () => {
    const onChange = vi.fn();

    render(<ActivityFilters level="all" onChange={onChange} source="all" />);
    fireEvent.click(screen.getByRole("button", { name: "Error" }));

    expect(onChange).toHaveBeenCalledWith({ level: "error" });
  });

  test("ActivityFeedPage names the recent activity list and keeps it keyboard focusable", () => {
    routerState.search = {};
    activityHook.useActivity.mockReturnValue({
      data: {
        events: [event({ summary: "keyboard accessible activity event" })],
      },
      isLoading: false,
    });

    render(<ActivityFeedPage />);

    const recentActivity = screen.getByRole("list", { name: "Recent activity" });

    expect(recentActivity).toHaveAttribute("tabindex", "0");

    recentActivity.focus();

    expect(recentActivity).toHaveFocus();
  });

  test("ActivityFeedPage starts at the URL page size and loads more", () => {
    routerState.search = { per: "2" };
    activityHook.useActivity.mockReturnValue({
      data: {
        events: [
          event({ summary: "alpha activity event" }),
          event({ summary: "beta activity event" }),
          event({ summary: "gamma activity event" }),
        ],
      },
      isLoading: false,
    });

    render(<ActivityFeedPage />);

    expect(screen.getByText("Showing 2 of 3")).toBeInTheDocument();
    expect(screen.queryByText("gamma activity event")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /load more activity/i }));

    expect(screen.getByText("gamma activity event")).toBeInTheDocument();
  });
});
