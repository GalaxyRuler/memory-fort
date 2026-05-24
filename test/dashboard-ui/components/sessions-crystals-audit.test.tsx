import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AuditPage } from "../../../src/dashboard-ui/components/AuditPage.js";
import { AuditRow } from "../../../src/dashboard-ui/components/AuditRow.js";
import { CrystalRotatingIcon } from "../../../src/dashboard-ui/components/CrystalRotatingIcon.js";
import { CrystalsPage } from "../../../src/dashboard-ui/components/CrystalsPage.js";
import { SessionsPage } from "../../../src/dashboard-ui/components/SessionsPage.js";
import { SessionTile } from "../../../src/dashboard-ui/components/SessionTile.js";
import type { ActivityEvent } from "../../../src/dashboard-ui/hooks/useActivity.js";

const routerState = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));

const rawHook = vi.hoisted(() => ({
  useRawIndex: vi.fn(),
}));

const wikiHook = vi.hoisted(() => ({
  useWikiIndex: vi.fn(),
}));

const activityHook = vi.hoisted(() => ({
  useActivity: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      children,
      className,
      params,
      to,
    }: {
      children: ReactNode;
      className?: string;
      params?: Record<string, string>;
      to: string;
    }) => {
      const href = params
        ? to
            .replace("$date", params.date ?? "")
            .replace("$filename", params.filename ?? "")
            .replace("$category", params.category ?? "")
            .replace("$slug", params.slug ?? "")
        : to;
      return (
        <a className={className} href={href}>
          {children}
        </a>
      );
    },
    useNavigate: () => routerState.navigate,
    useSearch: () => routerState.search,
  };
});

vi.mock("../../../src/dashboard-ui/hooks/useRawIndex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useRawIndex.js")>();
  return {
    ...actual,
    useRawIndex: rawHook.useRawIndex,
  };
});

vi.mock("../../../src/dashboard-ui/hooks/useWikiIndex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useWikiIndex.js")>();
  return {
    ...actual,
    useWikiIndex: wikiHook.useWikiIndex,
  };
});

vi.mock("../../../src/dashboard-ui/hooks/useActivity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useActivity.js")>();
  return {
    ...actual,
    useActivity: activityHook.useActivity,
  };
});

function activityEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    timestamp: "2026-05-24T12:00:00.000Z",
    source: "sync",
    level: "info",
    summary: "sync completed",
    ...overrides,
  };
}

describe("sessions, crystals, and audit secondary screens", () => {
  beforeEach(() => {
    routerState.search = {};
    routerState.navigate.mockReset();
    rawHook.useRawIndex.mockReset();
    wikiHook.useWikiIndex.mockReset();
    activityHook.useActivity.mockReset();
  });

  test("SessionTile renders source icon, session ID, and footer metrics", () => {
    render(
      <SessionTile
        date="2026-05-24"
        file={{
          filename: "claude-code-019e4bf7-d7b8-4a57.md",
          mtime: "2026-05-24T12:34:00.000Z",
          sizeBytes: 2048,
        }}
      />,
    );

    expect(screen.getByText("claude-code")).toBeInTheDocument();
    expect(screen.getByText(/019e4bf7/)).toBeInTheDocument();
    expect(screen.getByText("2.0KB")).toBeInTheDocument();
    expect(screen.getByText(/34/)).toBeInTheDocument();
  });

  test("SessionsPage filters by source", () => {
    routerState.search = { source: "codex" };
    rawHook.useRawIndex.mockReturnValue({
      data: [
        {
          date: "2026-05-24",
          files: [
            {
              filename: "claude-code-alpha.md",
              mtime: "2026-05-24T10:00:00.000Z",
              sizeBytes: 1024,
            },
            {
              filename: "codex-beta.md",
              mtime: "2026-05-24T11:00:00.000Z",
              sizeBytes: 2048,
            },
          ],
        },
      ],
      isLoading: false,
    });

    render(<SessionsPage />);

    expect(screen.getAllByText("codex")).toHaveLength(1);
    expect(screen.queryByText("claude-code")).not.toBeInTheDocument();
  });

  test("CrystalRotatingIcon has rotation animation class", () => {
    const { container } = render(<CrystalRotatingIcon />);

    expect(container.querySelector(".animate-spin-slow")).not.toBeNull();
  });

  test("CrystalsPage renders empty state when no crystals exist", () => {
    wikiHook.useWikiIndex.mockReturnValue({
      data: { byCategory: { crystal: [] }, total: 0 },
      isLoading: false,
    });

    render(<CrystalsPage />);

    expect(screen.getByText("No crystals yet")).toBeInTheDocument();
    expect(screen.getByText("memory crystallize")).toBeInTheDocument();
  });

  test("AuditRow uses the correct level color class", () => {
    const { container } = render(
      <ul>
        <AuditRow event={activityEvent({ level: "info", summary: "info row" })} />
        <AuditRow event={activityEvent({ level: "warn", summary: "warn row" })} />
        <AuditRow event={activityEvent({ level: "error", summary: "error row" })} />
      </ul>,
    );

    expect(container.querySelector(".text-status-green")).not.toBeNull();
    expect(container.querySelector(".text-status-amber")).not.toBeNull();
    expect(container.querySelector(".text-status-red")).not.toBeNull();
  });

  test("AuditPage in-page search input filters events", () => {
    activityHook.useActivity.mockReturnValue({
      data: {
        events: [
          activityEvent({ summary: "alpha sync event" }),
          activityEvent({ source: "compile", summary: "beta compile event" }),
          activityEvent({ level: "error", source: "errors", summary: "gamma error event" }),
        ],
      },
      isLoading: false,
    });

    render(<AuditPage />);

    fireEvent.change(screen.getByPlaceholderText("Search audit log..."), {
      target: { value: "beta" },
    });

    expect(screen.getByText("beta compile event")).toBeInTheDocument();
    expect(screen.queryByText("alpha sync event")).not.toBeInTheDocument();
    expect(screen.queryByText("gamma error event")).not.toBeInTheDocument();
  });
});
