import { fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(
      screen.queryByText(
        new Date("2026-05-24T12:34:00.000Z").toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      ),
    ).not.toBeInTheDocument();
  });

  test("SessionTile renders capture time decoded from Codex UUIDv7 filenames", () => {
    const captureTime = new Date(parseInt("019e4bf7d7b8", 16));
    const expectedTime = captureTime.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const mtimeTime = new Date("2026-05-24T12:34:00.000Z").toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    render(
      <SessionTile
        date="2026-05-24"
        file={{
          filename: "codex-019e4bf7-d7b8-7a57-8000-000000000000.md",
          mtime: "2026-05-24T12:34:00.000Z",
          sizeBytes: 2048,
        }}
      />,
    );

    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText(expectedTime)).toBeInTheDocument();
    expect(screen.queryByText(mtimeTime)).not.toBeInTheDocument();
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

  test("SessionsPage exposes keyboard cards as list items with nested links", () => {
    rawHook.useRawIndex.mockReturnValue({
      data: [
        {
          date: "2026-05-24",
          files: [
            {
              filename: "codex-alpha.md",
              mtime: "2026-05-24T11:00:00.000Z",
              sizeBytes: 2048,
            },
          ],
        },
      ],
      isLoading: false,
    });

    render(<SessionsPage />);

    const list = screen.getByRole("list", { name: "Sessions" });
    const item = within(list).getByRole("listitem");

    expect(within(item).getByRole("link", { name: /codex/i })).toHaveAttribute(
      "href",
      "/raw/2026-05-24/codex-alpha.md",
    );
  });

  test("SessionsPage starts at the URL page size and loads more", () => {
    routerState.search = { per: "2" };
    rawHook.useRawIndex.mockReturnValue({
      data: [
        {
          date: "2026-05-24",
          files: Array.from({ length: 3 }, (_, index) => ({
            filename: `codex-session-${index}.md`,
            mtime: `2026-05-24T1${index}:00:00.000Z`,
            sizeBytes: 1024,
          })),
        },
      ],
      isLoading: false,
    });

    render(<SessionsPage />);

    expect(screen.getByText("Showing 2 of 3")).toBeInTheDocument();
    expect(screen.getAllByText("codex")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /load more sessions/i }));

    expect(screen.getAllByText("codex")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /load more sessions/i })).not.toBeInTheDocument();
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

  test("CrystalsPage renders entries from the plural crystals category", () => {
    wikiHook.useWikiIndex.mockReturnValue({
      data: {
        byCategory: {
          crystals: [
            {
              category: "crystals",
              slug: "one",
              relPath: "crystals/one.md",
              title: "Crystal One",
              summary: "First distilled thread.",
              updated: "2026-05-24",
            },
            {
              category: "crystals",
              slug: "two",
              relPath: "crystals/two.md",
              title: "Crystal Two",
              summary: "Second distilled thread.",
              updated: "2026-05-25",
            },
            {
              category: "crystals",
              slug: "three",
              relPath: "crystals/three.md",
              title: "Crystal Three",
              summary: "Third distilled thread.",
              updated: "2026-05-26",
            },
            {
              category: "crystals",
              slug: "four",
              relPath: "crystals/four.md",
              title: "Crystal Four",
              summary: "Fourth distilled thread.",
              updated: "2026-05-27",
            },
          ],
        },
        total: 4,
      },
      isLoading: false,
    });

    render(<CrystalsPage />);

    expect(screen.getByText("Crystal One")).toBeInTheDocument();
    expect(screen.getByText("Crystal Two")).toBeInTheDocument();
    expect(screen.getByText("Crystal Three")).toBeInTheDocument();
    expect(screen.getByText("Crystal Four")).toBeInTheDocument();
    expect(screen.queryByText("No crystals yet")).not.toBeInTheDocument();
  });

  test("CrystalsPage exposes crystal cards as list items with nested links", () => {
    wikiHook.useWikiIndex.mockReturnValue({
      data: {
        byCategory: {
          crystals: [
            {
              category: "crystals",
              slug: "one",
              relPath: "crystals/one.md",
              title: "Crystal One",
              summary: "First distilled thread.",
              updated: "2026-05-24",
            },
          ],
        },
        total: 1,
      },
      isLoading: false,
    });

    render(<CrystalsPage />);

    const list = screen.getByRole("list", { name: "Crystals" });
    const item = within(list).getByRole("listitem");

    expect(within(item).getByRole("link", { name: /Crystal One/i })).toHaveAttribute(
      "href",
      "/wiki/crystal/one",
    );
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

  test("AuditPage starts at the URL page size and loads more", () => {
    routerState.search = { per: "2" };
    activityHook.useActivity.mockReturnValue({
      data: {
        events: [
          activityEvent({ summary: "alpha audit event" }),
          activityEvent({ summary: "beta audit event" }),
          activityEvent({ summary: "gamma audit event" }),
        ],
      },
      isLoading: false,
    });

    render(<AuditPage />);

    expect(screen.getByText("Showing 2 of 3")).toBeInTheDocument();
    expect(screen.queryByText("gamma audit event")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /load more audit entries/i }));

    expect(screen.getByText("gamma audit event")).toBeInTheDocument();
  });
});
